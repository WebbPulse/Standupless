locals {
  cycle_close_enabled = local.domain_functions_enabled

  cycle_close_payload = jsonencode({
    Records = [
      {
        eventSource = "standupless.cycle-close"
        eventName   = "SWEEP"
        eventID     = "cycle-close"
      },
    ]
  })
}

resource "aws_iam_role" "cycle_close_scheduler" {
  count = local.cycle_close_enabled ? 1 : 0

  name = "${local.prefix}-cycle-close-scheduler"

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

  tags = { Name = "${local.prefix}-cycle-close-scheduler" }
}

resource "aws_iam_role_policy" "cycle_close_scheduler" {
  count = local.cycle_close_enabled ? 1 : 0

  name = "invoke-issues"
  role = aws_iam_role.cycle_close_scheduler[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InvokeTheIssuesFunction"
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = module.lambda_domain["issues"].function_arn
      },
    ]
  })
}

resource "aws_scheduler_schedule" "cycle_close" {
  count = local.cycle_close_enabled ? 1 : 0

  name        = "${local.prefix}-cycle-close"
  description = "Hourly cycle close sweep - rolls unfinished issues of ended cycles into the next cycle."

  schedule_expression          = "rate(1 hour)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode                      = "FLEXIBLE"
    maximum_window_in_minutes = 15
  }

  target {
    arn      = module.lambda_domain["issues"].function_arn
    role_arn = aws_iam_role.cycle_close_scheduler[0].arn
    input    = local.cycle_close_payload

    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 3
    }
  }
}
