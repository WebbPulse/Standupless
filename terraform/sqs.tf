locals {
  github_queues_enabled = local.domain_functions_enabled && var.github_queues_enabled
}

module "github_events_queue" {
  count = local.github_queues_enabled ? 1 : 0

  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/sqs-queue"
  version = "~> 2.25"

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
  version = "~> 2.25"

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
