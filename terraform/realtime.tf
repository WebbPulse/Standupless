locals {
  realtime_enabled = local.domain_functions_enabled

  realtime_stage = var.environment

  realtime_management_url = local.realtime_enabled ? "https://${aws_apigatewayv2_api.realtime[0].id}.execute-api.${var.aws_region}.amazonaws.com/${local.realtime_stage}" : ""

  realtime_two_way_routes = ["heartbeat", "presence"]

  realtime_routes = local.realtime_enabled ? toset(["$connect", "$disconnect", "heartbeat", "presence", "presence_leave"]) : toset([])
}

resource "aws_apigatewayv2_api" "realtime" {
  count = local.realtime_enabled ? 1 : 0

  name                       = "${local.prefix}-realtime"
  description                = "Standupless ${var.environment} change notices over WebSocket"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_apigatewayv2_integration" "realtime" {
  count = local.realtime_enabled ? 1 : 0

  api_id                    = aws_apigatewayv2_api.realtime[0].id
  integration_type          = "AWS_PROXY"
  integration_method        = "POST"
  integration_uri           = module.lambda_domain["integrations-realtime-consumer"].invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
  passthrough_behavior      = "WHEN_NO_MATCH"
  timeout_milliseconds      = 10000
}

resource "aws_apigatewayv2_route" "realtime" {
  for_each = local.realtime_routes

  api_id                              = aws_apigatewayv2_api.realtime[0].id
  route_key                           = each.key
  target                              = "integrations/${aws_apigatewayv2_integration.realtime[0].id}"
  route_response_selection_expression = contains(local.realtime_two_way_routes, each.key) ? "$default" : null
}

resource "aws_apigatewayv2_route_response" "realtime_heartbeat" {
  count = local.realtime_enabled ? 1 : 0

  api_id             = aws_apigatewayv2_api.realtime[0].id
  route_id           = aws_apigatewayv2_route.realtime["heartbeat"].id
  route_response_key = "$default"
}

resource "aws_apigatewayv2_route_response" "realtime_presence" {
  count = local.realtime_enabled ? 1 : 0

  api_id             = aws_apigatewayv2_api.realtime[0].id
  route_id           = aws_apigatewayv2_route.realtime["presence"].id
  route_response_key = "$default"
}

resource "aws_apigatewayv2_stage" "realtime" {
  count = local.realtime_enabled ? 1 : 0

  api_id      = aws_apigatewayv2_api.realtime[0].id
  name        = local.realtime_stage
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.realtime_throttle_burst_limit
    throttling_rate_limit  = var.realtime_throttle_rate_limit
  }

  depends_on = [aws_apigatewayv2_route.realtime]
}

resource "aws_lambda_permission" "realtime" {
  count = local.realtime_enabled ? 1 : 0

  statement_id  = "AllowRealtimeWebSocketInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_domain["integrations-realtime-consumer"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.realtime[0].execution_arn}/*/*"
}
