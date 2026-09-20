module "app_secrets" {
  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/app-secrets"
  version = "~> 2.27"

  name_prefix = local.prefix

  json_generate_carry_enabled = local.domain_functions_enabled

  secrets = {
    "app" = {
      description = "JSON map of runtime secrets read by the Lambda API at cold start"
      version     = 2
      json = {
        SECRET_KEY = var.secret_key

        OAUTH_GOOGLE_CLIENT_SECRET = var.oauth_google_client_secret
        OAUTH_GITHUB_CLIENT_SECRET = var.oauth_github_client_secret

        GITHUB_APP_ID         = var.github_app_id
        GITHUB_CLIENT_ID      = var.github_client_id
        GITHUB_CLIENT_SECRET  = var.github_client_secret
        GITHUB_PRIVATE_KEY    = var.github_private_key
        GITHUB_WEBHOOK_SECRET = var.github_webhook_secret
      }
      json_generate = {
        mfa_master_key = {
          format = "bytes32-base64"
          keep   = true
        }
        WEBHOOK_SIGNING_KEY = {
          format = "bytes32-base64"
          keep   = true
        }
      }
    }
  }
}
