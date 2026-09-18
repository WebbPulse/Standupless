locals {
  issues_stream_enabled = var.issues_stream_enabled && contains(keys(local.lambda_domains), "issues")

  issues_stream_actions = [
    "dynamodb:DescribeStream",
    "dynamodb:GetRecords",
    "dynamodb:GetShardIterator",
    "dynamodb:ListStreams",
  ]
}

variable "issues_stream_enabled" {
  description = "Whether the issues table's stream is wired to the issues function's rollup consumer. Off by default so the table, the consumer route and this wiring can land before the mapping is switched on, and so an account applying before the issues image exists is not left with a mapping pointing at no function. Turn it on once the issues function is deployed and serving its pass-through path."
  type        = bool
  default     = false
}

resource "aws_lambda_event_source_mapping" "issues_rollup" {
  count = local.issues_stream_enabled ? 1 : 0

  event_source_arn  = module.dynamodb.stream_arns["issues"]
  function_name     = module.lambda_domain["issues"].function_name
  starting_position = "LATEST"

  batch_size                         = 100
  maximum_retry_attempts             = 3
  bisect_batch_on_function_error     = true
  maximum_batching_window_in_seconds = 5

  function_response_types = ["ReportBatchItemFailures"]

  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["INSERT", "MODIFY", "REMOVE"]
      })
    }
  }

  lifecycle {
    precondition {
      condition     = module.dynamodb.stream_arns["issues"] != null
      error_message = "issues_stream_enabled is true but the issues table has no stream. The table spec in backend/app/common/db/dynamo/tables.py sets stream_view_type, so regenerate terraform/dynamodb_tables.json with scripts/export_dynamo_tables.py and apply the table change first."
    }
  }

  depends_on = [aws_iam_role_policy.issues_stream]
}

resource "aws_iam_role_policy" "issues_stream" {
  count = local.issues_stream_enabled ? 1 : 0

  name = "issues-rollup-stream"
  role = module.lambda_domain["issues"].role_id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadTheIssuesTableStream"
        Effect   = "Allow"
        Action   = local.issues_stream_actions
        Resource = [module.dynamodb.stream_arns["issues"]]
      },
    ]
  })
}
