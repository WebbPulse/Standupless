module "app_secrets" {
  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/app-secrets"
  version = "~> 2.22"

  name_prefix = local.prefix

  secrets = {
    "app" = {
      description = "JSON map of runtime secrets read by the Lambda API at cold start"
      version     = 1
      json = {
        SECRET_KEY = var.secret_key

        OAUTH_GOOGLE_CLIENT_SECRET = var.oauth_google_client_secret
        OAUTH_GITHUB_CLIENT_SECRET = var.oauth_github_client_secret
      }
      json_generate = {
        mfa_master_key = {
          format = "bytes32-base64"
          keep   = true
        }
      }
    }
  }
}
