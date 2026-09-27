moved {
  from = module.api.aws_apigatewayv2_integration.this["projects"]
  to   = module.api.aws_apigatewayv2_integration.this["teams"]
}
