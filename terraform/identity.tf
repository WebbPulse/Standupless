locals {
  identity_issuer = "https://${local.custom_domain ? "api.${local.domain_name}" : replace(local.api_url, "https://", "")}/api/auth"

  identity_audience = "standupless-${var.environment}-api"

  identity_registrable_domain = local.domain_name

  identity_signing_key_arns = module.identity.signing_key_arns

  identity_oauth_redirect_uris = jsonencode(["${local.identity_issuer}/oauth/callback"])

  identity_webauthn_origins = jsonencode([local.frontend_url])

  identity_api_key_writer_domains = ["workspaces"]

  identity_api_key_reader_domains = [
    "projects",
    "issues",
    "views",
    "discussion",
    "planning",
    "integrations",
  ]

  identity_share_token_writer_domains = ["views"]

  identity_additional_table_grants = local.domain_functions_enabled ? merge(
    {
      for name in local.identity_api_key_writer_domains :
      "api-keys-write-${name}" => {
        role_name = module.lambda_domain[name].role_id
        tables    = ["api-keys"]
        actions   = local.dynamodb_domain_write_actions
      }
    },
    {
      for name in local.identity_api_key_reader_domains :
      "api-keys-read-${name}" => {
        role_name = module.lambda_domain[name].role_id
        tables    = ["api-keys"]
        actions   = local.dynamodb_domain_read_actions
      }
    },
    {
      for name in local.identity_share_token_writer_domains :
      "share-tokens-write-${name}" => {
        role_name = module.lambda_domain[name].role_id
        tables    = ["share-tokens"]
        actions   = local.dynamodb_domain_write_actions
      }
    },
  ) : {}
}

module "identity" {
  source = "app.terraform.io/WebbPulse/platform-modules/aws//modules/identity"

  version = "~> 2.28"

  name_prefix        = local.prefix
  issuer             = local.identity_issuer
  audience           = local.identity_audience
  registrable_domain = local.identity_registrable_domain

  identity_role_name = local.domain_functions_enabled ? module.lambda_domain["identity"].role_id : null
  identity_role_arn  = local.domain_functions_enabled ? module.lambda_domain["identity"].role_arn : null

  enable_mfa_encryption_key = false

  attach_role_policies = local.domain_functions_enabled

  users_stream_enabled   = local.domain_functions_enabled
  users_table_stream_arn = local.domain_functions_enabled ? module.dynamodb.stream_arns["users"] : null
  identity_function_name = local.domain_functions_enabled ? module.lambda_domain["identity"].function_name : null
  users_key_attribute    = "id"

  point_in_time_recovery = true

  deletion_protection = var.environment == "production"

  table_policy_actions = local.dynamodb_domain_write_actions

  api_keys_table_enabled     = true
  share_tokens_table_enabled = true

  additional_table_grants = local.identity_additional_table_grants

  name_tag = true
}
