locals {
  notify_digest_enabled = local.views_notify_stream_enabled

  notify_digest_payload = jsonencode({
    Records = [
      {
        eventSource = "standupless.notify-digest"
        eventName   = "FLUSH"
        eventID     = "notify-digest"
      },
    ]
  })
}

resource "aws_iam_role" "notify_digest_scheduler" {
  count = local.notify_digest_enabled ? 1 : 0

  name = "${local.prefix}-notify-digest-scheduler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "scheduler.amazonaws.com" }
        Action    = "sts:AssumeRole"
        Condition = {
          StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
        }
      },
    ]
  })

  tags = { Name = "${local.prefix}-notify-digest-scheduler" }
}

resource "aws_iam_role_policy" "notify_digest_scheduler" {
  count = local.notify_digest_enabled ? 1 : 0

  name = "invoke-views-notify-consumer"
  role = aws_iam_role.notify_digest_scheduler[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InvokeTheViewsNotifyConsumer"
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = module.lambda_domain["views-notify-consumer"].function_arn
      },
    ]
  })
}

resource "aws_scheduler_schedule" "notify_digest" {
  count = local.notify_digest_enabled ? 1 : 0

  name        = "${local.prefix}-notify-digest"
  description = "Every minute notification digest flush - mails each recipient one email per closed five minute window."

  schedule_expression          = "rate(1 minute)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = module.lambda_domain["views-notify-consumer"].function_arn
    role_arn = aws_iam_role.notify_digest_scheduler[0].arn
    input    = local.notify_digest_payload

    retry_policy {
      maximum_event_age_in_seconds = 300
      maximum_retry_attempts       = 2
    }
  }
}
