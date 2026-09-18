locals {
  identity_issuer = "https://${local.custom_domain ? "api.${local.domain_name}" : replace(local.api_url, "https://", "")}/api/auth"

  identity_audience = "standupless-${var.environment}-api"

  identity_registrable_domain = local.domain_name

  identity_signing_key_arns = module.identity.signing_key_arns

  identity_oauth_redirect_uris = jsonencode(["${local.identity_issuer}/oauth/callback"])

  identity_webauthn_origins = jsonencode([local.frontend_url])
}

module "identity" {
  source = "app.terraform.io/WebbPulse/platform-modules/aws//modules/identity"

  version = "~> 2.22"

  name_prefix        = local.prefix
  issuer             = local.identity_issuer
  audience           = local.identity_audience
  registrable_domain = local.identity_registrable_domain

  identity_role_name = module.lambda_domain["identity"].role_id
  identity_role_arn  = module.lambda_domain["identity"].role_arn

  enable_mfa_encryption_key = false

  attach_role_policies = true

  users_stream_enabled   = true
  users_table_stream_arn = module.dynamodb.stream_arns["users"]
  identity_function_name = module.lambda_domain["identity"].function_name
  users_key_attribute    = "id"

  point_in_time_recovery = true

  deletion_protection = var.environment == "production"

  table_policy_actions = local.dynamodb_domain_write_actions

  name_tag = true
}
