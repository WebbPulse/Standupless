locals {
  github_queues_enabled = local.domain_functions_enabled && var.github_queues_enabled
}

module "github_events_queue" {
  count = local.github_queues_enabled ? 1 : 0

  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/sqs-queue"
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

  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/sqs-queue"
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

  team_purge_stages = ["discussion", "integrations", "views", "planning", "issues", "teams"]

  team_purge_next_stage = {
    discussion   = "integrations"
    integrations = "views"
    views        = "planning"
    planning     = "issues"
    issues       = "teams"
    teams        = ""
  }

  team_purge_consumer_stages = { for stage in local.team_purge_stages : "${stage}-purge-consumer" => stage }

  team_purge_senders = local.team_purge_enabled ? merge(
    { teams = ["discussion"] },
    {
      for name, stage in local.team_purge_consumer_stages :
      name => compact([stage, local.team_purge_next_stage[stage]])
    },
  ) : {}
}

module "team_purge_queue" {
  for_each = local.team_purge_enabled ? toset(local.team_purge_stages) : toset([])

  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/sqs-queue"
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
