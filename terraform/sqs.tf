locals {
  github_queues_enabled = local.domain_functions_enabled && var.github_queues_enabled
}

module "github_events_queue" {
  count = local.github_queues_enabled ? 1 : 0

  source  = "terraform.webbpulse.com/WebbPulse/platform-modules/aws//modules/sqs-queue"
  version = "~> 2.27"

  name = "${local.prefix}-github-events"

  visibility_timeout_seconds = 180
  consumer_timeout_seconds   = 29

  message_retention_seconds = 345600

  max_receive_count = 5

  tags = { Name = "${local.prefix}-github-events" }
}

module "webhook_dispatch_queue" {
  count = local.github_queues_enabled ? 1 : 0

  source  = "terraform.webbpulse.com/WebbPulse/platform-modules/aws//modules/sqs-queue"
  version = "~> 2.27"

  name = "${local.prefix}-webhook-dispatch"

  visibility_timeout_seconds = 180
  consumer_timeout_seconds   = 29

  message_retention_seconds = 345600

  max_receive_count = 5

  tags = { Name = "${local.prefix}-webhook-dispatch" }
}

resource "aws_iam_role_policy" "integrations_queues" {
  for_each = local.github_queues_enabled ? toset([
    "integrations",
    "integrations-events-consumer",
    "integrations-dispatch-consumer",
    "integrations-stream-consumer",
  ]) : toset([])

  name = "${each.key}-queues"
  role = module.lambda_domain[each.key].role_id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SendToTheIntegrationQueues"
        Effect = "Allow"
        Action = ["sqs:SendMessage", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]
        Resource = [
          module.github_events_queue[0].queue_arn,
          module.webhook_dispatch_queue[0].queue_arn,
        ]
      },
    ]
  })
}

locals {
  team_purge_enabled = local.domain_functions_enabled && var.team_purge_enabled

  team_purge_stages = ["discussion", "integrations", "views", "planning", "issues", "teams", "workspaces"]

  team_purge_sends_to = {
    discussion   = ["integrations"]
    integrations = ["views"]
    views        = ["planning", "workspaces"]
    planning     = ["issues"]
    issues       = ["teams"]
    teams        = ["workspaces"]
    workspaces   = ["discussion", "views"]
  }

  team_purge_consumer_stages = { for stage in local.team_purge_stages : "${stage}-purge-consumer" => stage }

  team_purge_senders = local.team_purge_enabled ? merge(
    { teams = ["discussion"], integrations = ["discussion"], identity = ["workspaces"] },
    {
      for name, stage in local.team_purge_consumer_stages :
      name => concat([stage], local.team_purge_sends_to[stage])
    },
  ) : {}
}

module "team_purge_queue" {
  for_each = local.team_purge_enabled ? toset(local.team_purge_stages) : toset([])

  source  = "terraform.webbpulse.com/WebbPulse/platform-modules/aws//modules/sqs-queue"
  version = "~> 2.27"

  name = "${local.prefix}-team-purge-${each.key}"

  visibility_timeout_seconds = 180
  consumer_timeout_seconds   = 29

  message_retention_seconds = 345600

  max_receive_count = 5

  tags = { Name = "${local.prefix}-team-purge-${each.key}" }
}

resource "aws_iam_role_policy" "team_purge_queues" {
  for_each = local.team_purge_senders

  name = "${each.key}-team-purge-queues"
  role = module.lambda_domain[each.key].role_id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SendToTheTeamPurgeQueues"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]
        Resource = [for stage in each.value : module.team_purge_queue[stage].queue_arn]
      },
    ]
  })
}

resource "aws_iam_role" "team_purge_sweep_schedule" {
  count = local.team_purge_enabled ? 1 : 0

  name = "${local.prefix}-team-purge-sweep-schedule"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "scheduler.amazonaws.com" }
        Action    = "sts:AssumeRole"
        Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
      },
    ]
  })
}

resource "aws_iam_role_policy" "team_purge_sweep_schedule" {
  count = local.team_purge_enabled ? 1 : 0

  name = "${local.prefix}-team-purge-sweep-schedule"
  role = aws_iam_role.team_purge_sweep_schedule[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SendTheSweepToTheWorkspacesStage"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [module.team_purge_queue["workspaces"].queue_arn]
      },
    ]
  })
}

resource "aws_scheduler_schedule" "team_purge_sweep" {
  count = local.team_purge_enabled ? 1 : 0

  name        = "${local.prefix}-team-purge-sweep"
  description = "Hourly sweep that starts every due workspace purge and every deleted account purge not yet finished."

  schedule_expression = "rate(1 hour)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = module.team_purge_queue["workspaces"].queue_arn
    role_arn = aws_iam_role.team_purge_sweep_schedule[0].arn
    input = jsonencode({
      name    = "team.purge"
      payload = { kind = "sweep", stage = "workspaces" }
    })
  }
}
