locals {
  project = "standupless"

  prefix = "${local.project}-${var.environment}"

  common_tags = {
    Project     = local.project
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  custom_domain = coalesce(var.custom_domain_enabled, var.environment == "production" || var.staging_profile == "full")

  domain_name       = var.environment == "production" ? var.domain_name : "staging.${var.domain_name}"
  active_domain     = local.custom_domain ? local.domain_name : var.domain_name
  parent_delegation = var.environment == "staging" && local.custom_domain

  email_from = coalesce(var.email_from, "no-reply@${local.active_domain}")

  staging_gate_enabled = var.environment == "staging" && var.staging_access_gate && local.custom_domain
  staging_gate_count   = local.staging_gate_enabled ? 1 : 0

  frontend_url = module.frontend.frontend_url
  api_url      = module.api.api_url

  frontend_api_base_url = local.api_url

  identity_jwt_gate_enforced   = var.identity_jwt_mode == "gate" && local.staging_gate_enabled && local.domain_functions_enabled
  identity_jwt_native_enforced = var.identity_jwt_mode == "native" && local.domain_functions_enabled

  dev_origins     = ["http://localhost", "http://localhost:3000", "http://localhost:4000"]
  site_origins    = local.custom_domain ? ["https://${local.domain_name}", "https://www.${local.domain_name}"] : [local.frontend_url]
  browser_origins = var.environment == "production" ? local.site_origins : concat(local.dev_origins, local.site_origins)

  allowed_origins = join(",", local.browser_origins)

  cors_allow_origins = local.browser_origins
}
