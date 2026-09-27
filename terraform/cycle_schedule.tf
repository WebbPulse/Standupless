locals {
  cycle_schedule_enabled = local.domain_functions_enabled

  cycle_schedule_payload = jsonencode({
    Records = [
      {
        eventSource = "standupless.cycle-schedule"
        eventName   = "SWEEP"
        eventID     = "cycle-schedule"
      },
    ]
  })
}

resource "aws_iam_role" "cycle_schedule_scheduler" {
  count = local.cycle_schedule_enabled ? 1 : 0

  name = "${local.prefix}-cycle-schedule-scheduler"

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

  tags = { Name = "${local.prefix}-cycle-schedule-scheduler" }
}

resource "aws_iam_role_policy" "cycle_schedule_scheduler" {
  count = local.cycle_schedule_enabled ? 1 : 0

  name = "invoke-planning-rollup-consumer"
  role = aws_iam_role.cycle_schedule_scheduler[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InvokeThePlanningRollupConsumer"
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = module.lambda_domain["planning-rollup-consumer"].function_arn
      },
    ]
  })
}

resource "aws_scheduler_schedule" "cycle_schedule" {
  count = local.cycle_schedule_enabled ? 1 : 0

  name        = "${local.prefix}-cycle-schedule"
  description = "Hourly automatic cycles sweep - keeps every team with cycles on stocked with its current and upcoming cycles."

  schedule_expression          = "rate(1 hour)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode                      = "FLEXIBLE"
    maximum_window_in_minutes = 15
  }

  target {
    arn      = module.lambda_domain["planning-rollup-consumer"].function_arn
    role_arn = aws_iam_role.cycle_schedule_scheduler[0].arn
    input    = local.cycle_schedule_payload

    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 3
    }
  }
}
