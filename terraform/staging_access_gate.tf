module "staging_access_gate" {
  count = local.staging_gate_count

  source = "app.terraform.io/WebbPulse/platform-modules/aws//modules/staging-access-gate"

  version = "~> 2.27"

  name              = local.prefix
  cookie_domain     = local.domain_name
  site_host         = local.domain_name
  additional_hosts  = ["www.${local.domain_name}"]
  allowed_emails    = var.staging_access_users
  http_api_id       = module.api.api_id
  http_api_attached = true
  invite_login_url  = "https://${local.domain_name}/"

  viewer_request_handler_js = templatefile("${path.module}/cloudfront_functions/app_handler.js.tftpl", { domain = local.active_domain })

  identity_jwt = local.identity_jwt_gate_enforced ? {
    issuer           = local.identity_issuer
    audience         = local.identity_audience
    api_key_prefixes = local.identity_api_key_prefixes
  } : null

  identity_jwt_route_keys = local.identity_jwt_gate_enforced ? module.api.identity_jwt_route_keys : []
}
