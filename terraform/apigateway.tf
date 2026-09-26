locals {
  routed_lambda_domains_declared = ["identity", "workspaces", "teams", "issues", "views", "discussion", "planning", "integrations", "admin"]

  routed_lambda_domains = [
    for name in local.routed_lambda_domains_declared : name
    if contains(keys(local.lambda_domains), name)
  ]

  lambda_domain_path_prefixes = {
    identity   = ["/api/auth", "/api/users"]
    workspaces = ["/api/workspaces", "/api/invites"]
    teams      = ["/api/workspaces/{workspace_id}/teams"]
    issues     = ["/api/workspaces/{workspace_id}/issues"]
    views = [
      "/api/workspaces/{workspace_id}/board",
      "/api/workspaces/{workspace_id}/views",
      "/api/workspaces/{workspace_id}/search",
      "/api/workspaces/{workspace_id}/inbox",
    ]

    # The comment thread sits under the issues prefix's own subtree, so it is
    # reached on specificity rather than on order: an HTTP API picks the most
    # specific match, and ".../issues/{issue_id}/comments" beats
    # ".../issues/{proxy+}" because the literal segments outrank the greedy one.
    # The other three are ordinary siblings of the issues prefix.
    discussion = [
      "/api/workspaces/{workspace_id}/issues/{issue_id}/comments",
      "/api/workspaces/{workspace_id}/comments",
      "/api/workspaces/{workspace_id}/reactions",
      "/api/workspaces/{workspace_id}/attachments",
    ]

    planning = [
      "/api/workspaces/{workspace_id}/cycles",
      "/api/workspaces/{workspace_id}/projects",
      "/api/workspaces/{workspace_id}/roadmap",
    ]

    # Three of these sit inside another domain's subtree and are reached on
    # specificity, the same way the comment thread is: the literal segments in
    # ".../issues/{issue_id}/github-links" outrank the greedy "{proxy+}" the
    # issues domain claims, and likewise for the two team settings paths. The
    # workspace webhooks prefix is an ordinary sibling.
    integrations = [
      "/api/workspaces/{workspace_id}/issues/{issue_id}/github-links",
      "/api/workspaces/{workspace_id}/teams/{team_id}/github-transitions",
      "/api/workspaces/{workspace_id}/github",
      "/api/workspaces/{workspace_id}/webhooks",
    ]

    admin = ["/api/admin"]
  }

  unauthenticated_route_prefixes = ["/api/auth"]

  lambda_domain_generated_route_keys = merge(flatten([
    for name in local.routed_lambda_domains : [
      for prefix in local.lambda_domain_path_prefixes[name] : {
        for key in ["ANY ${prefix}", "ANY ${prefix}/{proxy+}"] : key => merge(
          { integration = name },
          contains(local.unauthenticated_route_prefixes, prefix) ? {} : { require_identity_jwt = var.domain_jwt_enforced },
        )
      }
    ]
  ])...)

  ephemeral_users_route_keys = var.ephemeral_users_enabled && contains(local.routed_lambda_domains, "identity") ? {
    "POST /api/auth/e2e/users"             = { integration = "identity", require_identity_jwt = true }
    "DELETE /api/auth/e2e/users/{user_id}" = { integration = "identity", require_identity_jwt = true }
  } : {}

  identity_jwt_route_keys = contains(local.routed_lambda_domains, "identity") ? {
    "POST /api/auth/password"   = { integration = "identity", require_identity_jwt = true }
    "POST /api/auth/logout-all" = { integration = "identity", require_identity_jwt = true }

    "POST /api/auth/totp/enrol"     = { integration = "identity", require_identity_jwt = true }
    "POST /api/auth/totp/activate"  = { integration = "identity", require_identity_jwt = true }
    "POST /api/auth/totp/disable"   = { integration = "identity", require_identity_jwt = true }
    "POST /api/auth/recovery-codes" = { integration = "identity", require_identity_jwt = true }
    "POST /api/auth/step-up"        = { integration = "identity", require_identity_jwt = true }

    "POST /api/auth/passkeys/register/options"  = { integration = "identity", require_identity_jwt = true }
    "POST /api/auth/passkeys/register/verify"   = { integration = "identity", require_identity_jwt = true }
    "GET /api/auth/passkeys"                    = { integration = "identity", require_identity_jwt = true }
    "PATCH /api/auth/passkeys/{credential_id}"  = { integration = "identity", require_identity_jwt = true }
    "DELETE /api/auth/passkeys/{credential_id}" = { integration = "identity", require_identity_jwt = true }

    "POST /api/auth/oauth/{provider}/link"   = { integration = "identity", require_identity_jwt = true }
    "GET /api/auth/oauth/links"              = { integration = "identity", require_identity_jwt = true }
    "DELETE /api/auth/oauth/{provider}/link" = { integration = "identity", require_identity_jwt = true }
  } : {}

  domain_identity_jwt_route_paths = {
    workspaces = [
      "POST /api/workspaces",
      "GET /api/workspaces",
      "GET /api/workspaces/{workspace_id}",
      "PATCH /api/workspaces/{workspace_id}",
      "DELETE /api/workspaces/{workspace_id}",
    ]
  }

  domain_identity_jwt_route_keys = merge([
    for domain, keys in local.domain_identity_jwt_route_paths : {
      for key in keys : key => {
        integration          = domain
        require_identity_jwt = var.domain_jwt_enforced
      }
    } if contains(local.routed_lambda_domains, domain)
  ]...)

  # GitHub reaches these two directly, so neither can carry the workspace
  # authorizer: the callback arrives as a browser redirect with only the signed
  # state to prove it, and the webhook arrives with only its HMAC. Both are
  # merged last so their "NONE" wins over any generated entry, and both verify
  # their own credential before doing anything with the payload.
  github_webhook_route_keys = contains(local.routed_lambda_domains, "integrations") ? {
    "POST /api/github/webhooks" = { integration = "integrations", authorization_type = "NONE" }
    "GET /api/github/callback"  = { integration = "integrations", authorization_type = "NONE" }
  } : {}

  # An anonymous reader following a share link has no workspace to name and no
  # membership that would let them name one: the token in the path is the whole
  # credential, and it resolves the one row it grants before anything else is
  # read. Named on its own key rather than swept into the views prefix, so the
  # public surface is a list a person can count.
  share_link_public_route_keys = contains(local.routed_lambda_domains, "views") ? {
    "ANY /api/shared/{proxy+}" = { integration = "views", authorization_type = "NONE" }
  } : {}

  # The MCP endpoint is unauthenticated at the gateway so an unknown client can
  # reach it and receive the WWW-Authenticate challenge naming the authorization
  # server, which is how the discovery handshake starts. The route is not public:
  # every request carrying a body is refused in process without a verified bearer,
  # before anything reads a table.
  mcp_route_keys = contains(local.routed_lambda_domains, "integrations") ? {
    "ANY /api/mcp" = { integration = "integrations", authorization_type = "NONE" }
  } : {}

  # There are deliberately no root level "/.well-known" route keys. The identity
  # package serves both discovery documents under the issuer, at
  # "/api/auth/.well-known/...", and that is what the MCP endpoint's
  # WWW-Authenticate header names as resource_metadata, so a client is sent to the
  # path that answers. Root level keys forwarded to the same function, which serves
  # nothing there, so they only ever answered 404.

  # The three OAuth server endpoints an MCP client drives before it holds any
  # product credential. They sit under "/api/auth", whose prefix only drops the
  # identity JWT requirement and leaves authorization_type unset, which resolves
  # to CUSTOM wherever the staging access gate is attached. A client arriving from
  # outside a browser carries no gate cookie, so without these three the discovery
  # handshake would complete and the flow would then fail in staging only.
  #
  # Named individually rather than by opening the prefix: "/api/auth" also carries
  # login, registration and password reset, and putting those outside the gate
  # would expose the staging product itself. Each of these three is safe alone,
  # because the authorization server refuses an unregistered client, requires PKCE
  # S256, and binds every code to one workspace at consent.
  oauth_server_route_keys = contains(local.routed_lambda_domains, "identity") ? {
    "GET /api/auth/authorize"        = { integration = "identity", authorization_type = "NONE" }
    "POST /api/auth/token"           = { integration = "identity", authorization_type = "NONE" }
    "POST /api/auth/register-client" = { integration = "identity", authorization_type = "NONE" }
  } : {}

  lambda_domain_route_keys = merge(
    local.lambda_domain_generated_route_keys,
    local.identity_jwt_route_keys,
    local.ephemeral_users_route_keys,
    local.domain_identity_jwt_route_keys,
    local.github_webhook_route_keys,
    local.share_link_public_route_keys,
    local.oauth_server_route_keys,
    local.mcp_route_keys,
  )
}

module "api" {
  source = "app.terraform.io/WebbPulse/platform-modules/aws//modules/http-api"

  version = "~> 2.27"

  name        = "${local.prefix}-api"
  description = "Standupless ${var.environment} API (Lambda proxy)"

  integrations = {
    for name in local.routed_lambda_domains : name => {
      lambda_function_name = module.lambda_domain[name].function_name
      lambda_invoke_arn    = module.lambda_domain[name].invoke_arn
      timeout_milliseconds = 29000
    }
  }

  default_integration = null

  routes = local.lambda_domain_route_keys

  throttling_burst_limit    = var.api_throttle_burst_limit
  throttling_rate_limit     = var.api_throttle_rate_limit
  access_log_retention_days = 7

  cors_configuration = {
    allow_origins = local.cors_allow_origins
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = [
      "Accept",
      "Authorization",
      "Content-Type",
      "Origin",
      "X-Request-Id",
      "X-Requested-With",
      "X-Retry-Attempt",
    ]
    expose_headers = [
      "Retry-After",
      "X-RateLimit-Limit-Hour",
      "X-RateLimit-Limit-Minute",
      "X-Request-ID",
    ]
    allow_credentials = true
    max_age           = 86400
  }

  disable_execute_api_endpoint = local.staging_gate_enabled
  authorizer_id                = local.staging_gate_enabled ? module.staging_access_gate[0].http_api_authorizer_id : null

  identity_jwt = local.identity_jwt_native_enforced ? {
    issuer   = local.identity_issuer
    audience = local.identity_audience

    mode             = "lambda"
    api_key_prefixes = local.identity_api_key_prefixes
  } : null

  identity_jwt_depends_on = local.identity_jwt_native_enforced ? [module.lambda_domain["identity"]] : []

  domain_name        = local.custom_domain ? "api.${local.domain_name}" : null
  certificate_arn    = module.api_certificate.certificate_arn
  zone_id            = local.custom_domain ? module.staging_dns.zone_id : null
  dns_record_enabled = local.custom_domain
  domain_name_tags   = { Name = "${local.prefix}-api-domain" }
}
