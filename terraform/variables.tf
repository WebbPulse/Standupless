variable "aws_region" {
  description = "AWS region to deploy resources into"
  type        = string
  default     = "us-west-2"
}

variable "environment" {
  description = "Deployment environment (production, staging)"
  type        = string
  default     = "production"

  validation {
    condition     = contains(["production", "staging"], var.environment)
    error_message = "environment must be 'production' or 'staging'"
  }
}

variable "custom_domain_enabled" {
  description = "Provision Route53, ACM and custom hostnames. null = production or staging_profile 'full'."
  type        = bool
  default     = null
  nullable    = true
}

variable "domain_name" {
  description = "Registered apex domain. Production serves it directly; staging serves staging.<domain_name> from a delegated child zone."
  type        = string
  default     = "standupless.dev"
}

variable "parent_route53_zone_id" {
  description = "Hosted zone id of <domain_name> in the production account. Staging writes the NS delegation for its child zone into it. Pushed to the staging workspace by WebbPulse-Platform."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.environment != "staging" || !coalesce(var.custom_domain_enabled, var.staging_profile == "full") || var.parent_route53_zone_id != null
    error_message = "parent_route53_zone_id must be set when environment is 'staging' and the custom domain is on: the staging.<domain_name> zone is delegated from the parent zone owned by the production workspace. WebbPulse-Platform pushes it to the workspace."
  }
}

variable "route53_write_role_arn" {
  description = "IAM role in the production account assumed to write the NS delegation record into parent_route53_zone_id. Pushed to the staging workspace by WebbPulse-Platform; null means no cross-account provider is configured."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.environment != "staging" || !coalesce(var.custom_domain_enabled, var.staging_profile == "full") || var.route53_write_role_arn != null
    error_message = "route53_write_role_arn must be set when environment is 'staging' and the custom domain is on: the NS delegation for staging.<domain_name> is written into the parent zone through that role. WebbPulse-Platform pushes it to the workspace."
  }
}

variable "staging_profile" {
  description = "How much of the stack this environment provisions. 'none' means the environment is switched off and must not be built. Set on the workspace by the WebbPulse-Organization workspace factory."
  type        = string
  default     = "full"

  validation {
    condition     = contains(["none", "reduced", "full"], var.staging_profile)
    error_message = "staging_profile must be one of 'none', 'reduced', or 'full'."
  }

  validation {
    condition     = var.staging_profile != "none"
    error_message = "Refusing to plan: staging_profile is 'none', so this environment is switched off and no resources should be created in it. To stand this environment up, change staging_profile to 'reduced' or 'full' on the workspace in WebbPulse-Organization/bootstrap/locals.tf."
  }
}

variable "api_throttle_burst_limit" {
  description = "HTTP API $default stage throttling burst limit"
  type        = number
  default     = 50
}

variable "api_throttle_rate_limit" {
  description = "HTTP API $default stage steady-state requests per second"
  type        = number
  default     = 25
}

variable "secret_key" {
  description = "Application signing key for the few tokens Standupless signs itself. Every session token is RS256 and signed in KMS by the identity module, so this covers only the product's own short-lived links."
  type        = string
  sensitive   = true
  default     = ""
}

variable "email_from" {
  description = "Sender address for transactional email. null = no-reply@ the domain SES is verified for (the served domain with a custom domain, the apex otherwise)."
  type        = string
  default     = null
  nullable    = true
}

variable "staging_access_gate" {
  description = "Put the staging site and API behind the shared staging access gate (Cognito sign-in plus CloudFront signed cookies). WebbPulse-Platform sets this on staging workspaces only; production never receives it and every gate resource is skipped there."
  type        = bool
  default     = false
}

variable "staging_access_users" {
  description = "Email addresses allowed through the staging access gate; each becomes an invited Cognito user. WebbPulse-Platform sets this on staging workspaces only; production never receives it."
  type        = list(string)
  default     = []

  validation {
    condition     = !var.staging_access_gate || length(var.staging_access_users) > 0
    error_message = "staging_access_users must list at least one email when staging_access_gate is true. An empty list is a gate nobody can open."
  }
}

variable "passkeys_enabled" {
  description = "Mount the identity package's passkey routes on the identity function. False leaves them undeclared whatever the passkeys and webauthn-challenges tables hold."
  type        = bool
  default     = false
}

variable "passkeys_passwordless" {
  description = "Allow a passkey to be a first factor, so the passkey login routes serve. False with passkeys_enabled true mounts the management routes only, which makes a passkey a second factor."
  type        = bool
  default     = false
}

variable "oauth_google_client_id" {
  description = "Client id of the Google OAuth application. Empty means no Google route is declared and Google is not advertised on the providers route. Not a secret; set as an ordinary workspace variable."
  type        = string
  default     = ""
}

variable "oauth_google_client_secret" {
  description = "Client secret of the Google OAuth application, written into the app secret as OAUTH_GOOGLE_CLIENT_SECRET. An id set with no secret is a provider that is not advertised rather than a deployment that fails."
  type        = string
  sensitive   = true
  default     = ""
}

variable "oauth_github_client_id" {
  description = "Client id of the GitHub OAuth application. Empty means no GitHub route is declared and GitHub is not advertised on the providers route. Not a secret; set as an ordinary workspace variable."
  type        = string
  default     = ""
}

variable "oauth_github_client_secret" {
  description = "Client secret of the GitHub OAuth application, written into the app secret as OAUTH_GITHUB_CLIENT_SECRET. An id set with no secret is a provider that is not advertised rather than a deployment that fails."
  type        = string
  sensitive   = true
  default     = ""
}

variable "identity_jwt_mode" {
  description = "Which mechanism enforces identity access tokens at the gateway: the staging gate's Lambda authorizer (gate), API Gateway's own JWT authorizer (native), or nothing (off). A route takes exactly one authorizer, so a gated staging environment must use gate."
  type        = string
  default     = "off"

  validation {
    condition     = contains(["native", "gate", "off"], var.identity_jwt_mode)
    error_message = "identity_jwt_mode must be one of native, gate or off."
  }

  validation {
    condition     = var.identity_jwt_mode != "native" || var.environment != "staging"
    error_message = "identity_jwt_mode must not be native in staging. Every route there carries the staging access gate's REQUEST authorizer and a route takes exactly one authorizer, so a native JWT authorizer has no slot to occupy. Use gate, which moves the same check into the gate's own Lambda."
  }
}

variable "domain_jwt_enforced" {
  description = "Whether the workspaces route keys additionally require an identity access token at the gateway. The keys exist either way; this only marks them, which is what puts them in the gate Lambda's list."
  type        = bool
  default     = false
}

variable "ephemeral_users_enabled" {
  description = "Mount the admin-only ephemeral e2e user routes on the identity function, so the e2e suite creates one throwaway login user per worker. Off by default and set true only on the staging workspace."
  type        = bool
  default     = false
}
