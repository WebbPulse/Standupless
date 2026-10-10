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

variable "route53_read_role_arn" {
  description = "Read-only counterpart of route53_write_role_arn, assumed instead of it during plans on the WebbPulse control plane. Pushed by WebbPulse-Platform next to the writer; null when the writer is null."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.route53_write_role_arn == null || var.route53_read_role_arn != null
    error_message = "route53_read_role_arn must be set whenever route53_write_role_arn is: plans on the WebbPulse control plane assume the reader. WebbPulse-Platform pushes both to the workspace."
  }
}

variable "webbpulse_run_phase" {
  description = "Run phase the WebbPulse control plane exports as TF_VAR_webbpulse_run_phase: plan or apply. Plans assume route53_read_role_arn and applies route53_write_role_arn. Ephemeral so a saved plan never carries plan into its apply, and defaulted to apply so HCP Terraform, which never sets it, keeps the writer."
  type        = string
  default     = "apply"
  ephemeral   = true

  validation {
    condition     = contains(["plan", "apply"], var.webbpulse_run_phase)
    error_message = "webbpulse_run_phase must be plan or apply."
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
  default     = 1000
}

variable "api_throttle_rate_limit" {
  description = "HTTP API $default stage steady-state requests per second"
  type        = number
  default     = 500
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

variable "passkeys_second_factor" {
  description = "Let a registered passkey answer the MFA challenge of a password or OAuth sign-in, so a passkey counts as a second factor. Needs passkeys_enabled."
  type        = bool
  default     = false
}

variable "oauth_google_client_id" {
  description = "Client id of the Google OAuth application. Empty means no Google route is declared and Google is not advertised on the providers route. Not a secret; set in env/<environment>.tfvars."
  type        = string
  default     = ""
}

variable "desktop_handoff_schemes" {
  description = "Custom URL schemes the desktop app may receive a browser sign-in handoff on. Empty leaves the handoff routes unmounted. Not a secret; set in env/<environment>.tfvars."
  type        = list(string)
  default     = []
}

variable "oauth_github_client_id" {
  description = "Client id of the GitHub OAuth application. Empty means no GitHub route is declared and GitHub is not advertised on the providers route. Not a secret; set in env/<environment>.tfvars."
  type        = string
  default     = ""
}

variable "identity_jwt_mode" {
  description = "Which mechanism enforces identity access tokens at the gateway: the staging gate's Lambda authorizer (gate), the http-api module's own Lambda authorizer (native), or nothing (off). A route takes exactly one authorizer, so a gated staging environment must use gate. Both enforcing modes admit a bearer carrying an api_key_prefixes prefix and leave the backend to verify it, so an API key reaches a protected route in either."
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

  validation {
    condition     = var.identity_jwt_mode != "gate" || var.environment == "staging"
    error_message = "identity_jwt_mode gate only takes effect where the staging access gate exists. Outside staging it attaches no authorizer, so no session claims reach the backend and every signed in call answers 401. Use native."
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

variable "github_app_slug" {
  description = "URL slug of the GitHub App backing the integrations domain, as it appears in https://github.com/apps/<slug>. Used to build the install URL a workspace admin is sent to. The App is created by hand in the WebbPulse organization, so this is supplied rather than managed here."
  type        = string
  default     = ""
}

variable "github_queues_enabled" {
  description = "Whether the github-events and webhook-dispatch queues and their event source mappings exist. Off by default for the same reason the stream flags are: the queues, the consumer routes and this wiring land before the mappings are switched on, and an account applying before the integrations image is in ECR is not left with a mapping pointing at no function."
  type        = bool
  default     = false
}

variable "integrations_stream_enabled" {
  description = "Whether the issues and comments table streams are wired to the integrations outbound consumer, which turns product writes into outbound webhook deliveries. Held apart from the views stream flags so outbound delivery can be switched on independently of notifications and search."
  type        = bool
  default     = false
}

variable "team_purge_enabled" {
  description = "Whether the team purge chain exists: one queue with a dead-letter queue per domain stage, a purge consumer function per stage on its domain's image, their event source mappings, and the hourly sweep schedule that starts workspace purges once their grace period has run out and retries any deleted account's purge. Off by default for the same reason github_queues_enabled is: the code lands first and sends nothing while the queue URLs are empty, so a deleted team keeps its tombstone, a scheduled workspace deletion stays scheduled and a deleted account stays marked until this is switched on after every domain image carrying the purge entrypoints is in ECR."
  type        = bool
  default     = false
}

variable "workspace_export_enabled" {
  description = "Whether the workspace export queue, its dead-letter queue, the export consumer function on the workspaces image and its event source mapping exist. Off by default for the same reason team_purge_enabled is: the code lands first, and while the queue URL is empty a deployed environment refuses an export rather than building it inside a request. Switch it on once the workspaces image carrying the export entrypoint is in ECR."
  type        = bool
  default     = false
}

variable "issue_import_enabled" {
  description = "Whether the issue import queue, its dead-letter queue, the import consumer function on the integrations image and its event source mapping exist. Off by default for the same reason workspace_export_enabled is: the code lands first, and while the queue URL is empty a deployed environment refuses an import rather than writing it inside a request. Switch it on once the integrations image carrying the import entrypoint is in ECR."
  type        = bool
  default     = false
}

variable "billing_enabled" {
  description = "Whether workspaces can buy a paid plan. Sets BILLING_ENABLED on every function, because the free plan's real ceilings apply only while it is on. Off by default until the Stripe prices, webhook endpoint and portal configuration exist and STRIPE_WEBHOOK_SECRET is in the app secret."
  type        = bool
  default     = false
}

variable "billing_business_enabled" {
  description = "Whether the Business plan is on sale. Needs billing_enabled too, and stays off until private teams ship."
  type        = bool
  default     = false
}
