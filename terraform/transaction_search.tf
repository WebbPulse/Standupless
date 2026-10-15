module "transaction_search" {
  source  = "terraform.webbpulse.com/WebbPulse/platform-modules/aws//modules/transaction-search"
  version = "~> 2.41"

  name_prefix = local.prefix

  adopt_spans_log_group             = var.adopt_spans_log_group
  spans_log_group_retention_in_days = 7

  adopt_application_signals_log_group = true

  span_sample_ratio = 0.1
}

variable "adopt_spans_log_group" {
  description = "Adopt the reserved aws/spans log group into state and hold it at the platform's 7 day retention. X-Ray creates it on the first span export and CreateLogGroup rejects names beginning with aws/, so a brand new account applies once with this false, generates a span, then sets it true."
  type        = bool
  default     = false
}

import {
  for_each = var.adopt_spans_log_group ? toset(["aws/spans"]) : toset([])

  to = module.transaction_search.aws_cloudwatch_log_group.spans[each.key]
  id = each.value
}

import {
  to = module.transaction_search.aws_cloudwatch_log_group.application_signals["/aws/application-signals/data"]
  id = "/aws/application-signals/data"
}

moved {
  from = aws_cloudwatch_log_resource_policy.transaction_search_spans
  to   = module.transaction_search.aws_cloudwatch_log_resource_policy.spans
}

moved {
  from = aws_xray_trace_segment_destination.main
  to   = module.transaction_search.aws_xray_trace_segment_destination.this
}

moved {
  from = aws_xray_indexing_rule.default
  to   = module.transaction_search.aws_xray_indexing_rule.default[0]
}

moved {
  from = aws_cloudwatch_log_group.spans["aws/spans"]
  to   = module.transaction_search.aws_cloudwatch_log_group.spans["aws/spans"]
}
