locals {
  lambda_domains_declared = {
    identity = {
      secrets     = true
      ses         = true
      memory      = 512
      tables      = ["users", "rate-limits"]
      read_tables = ["memberships", "workspaces"]
    }
    workspaces = {
      secrets     = false
      ses         = false
      memory      = 512
      tables      = ["workspaces", "memberships", "invites", "api-keys", "rate-limits"]
      read_tables = ["users"]
    }
    projects = {
      secrets     = false
      ses         = false
      memory      = 512
      tables      = ["projects", "project_config", "counters", "memberships", "rate-limits"]
      read_tables = ["workspaces", "users", "api-keys"]
    }
    issues = {
      secrets     = false
      ses         = false
      memory      = 512
      tables      = ["issues", "relations", "activity", "counters", "rate-limits"]
      read_tables = ["memberships", "workspaces", "users", "projects", "project_config", "planning", "api-keys"]
    }
    views = {
      secrets     = false
      ses         = false
      memory      = 512
      tables      = ["views", "inbox", "search_index", "share-tokens", "rate-limits"]
      read_tables = ["memberships", "workspaces", "users", "projects", "project_config", "issues", "comments", "api-keys"]
    }
    views-notify-consumer = {
      secrets     = false
      ses         = false
      memory      = 512
      tables      = ["views", "inbox", "search_index", "rate-limits"]
      read_tables = ["memberships", "workspaces", "users", "projects", "project_config", "issues", "comments"]
    }
    views-search-consumer = {
      secrets     = false
      ses         = false
      memory      = 512
      tables      = ["views", "inbox", "search_index", "rate-limits"]
      read_tables = ["memberships", "workspaces", "users", "projects", "project_config", "issues", "comments"]
    }
    discussion = {
      secrets     = true
      ses         = false
      memory      = 512
      tables      = ["comments", "reactions", "attachments", "rate-limits"]
      read_tables = ["memberships", "workspaces", "users", "projects", "issues", "api-keys"]
    }
    planning = {
      secrets     = false
      ses         = false
      memory      = 512
      tables      = ["planning", "idempotency", "rate-limits"]
      read_tables = ["memberships", "workspaces", "users", "projects", "project_config", "issues", "api-keys"]
    }
    planning-rollup-consumer = {
      secrets     = false
      ses         = false
      memory      = 512
      tables      = ["planning", "idempotency", "rate-limits"]
      read_tables = ["memberships", "workspaces", "users", "projects", "project_config", "issues"]
    }
    integrations = {
      secrets     = true
      ses         = false
      memory      = 512
      tables      = ["github", "idempotency", "project_config", "issues", "comments", "counters", "activity", "rate-limits"]
      read_tables = ["memberships", "workspaces", "users", "projects", "api-keys"]
    }
    integrations-events-consumer = {
      secrets     = true
      ses         = false
      memory      = 512
      tables      = ["github", "idempotency", "issues", "activity", "rate-limits"]
      read_tables = ["memberships", "workspaces", "users", "projects", "project_config", "comments"]
    }
    integrations-dispatch-consumer = {
      secrets     = true
      ses         = false
      memory      = 512
      tables      = ["github", "idempotency", "project_config", "rate-limits"]
      read_tables = ["memberships", "workspaces", "users", "projects", "issues", "activity", "comments"]
    }
    integrations-stream-consumer = {
      secrets     = false
      ses         = false
      memory      = 512
      tables      = ["github", "rate-limits"]
      read_tables = ["memberships", "workspaces", "users", "projects", "project_config", "issues", "activity", "comments"]
    }
  }

  lambda_domain_images = {
    views-notify-consumer          = "views"
    views-search-consumer          = "views"
    planning-rollup-consumer       = "planning"
    integrations-events-consumer   = "integrations"
    integrations-dispatch-consumer = "integrations"
    integrations-stream-consumer   = "integrations"
  }

  lambda_domain_commands = {
    views-notify-consumer          = ["app.domains.views.consumers.notify_entrypoint"]
    views-search-consumer          = ["app.domains.views.consumers.search_entrypoint"]
    planning-rollup-consumer       = ["app.domains.planning.consumers.rollup_entrypoint"]
    integrations-events-consumer   = ["app.domains.integrations.consumers.events_entrypoint"]
    integrations-dispatch-consumer = ["app.domains.integrations.consumers.dispatch_entrypoint"]
    integrations-stream-consumer   = ["app.domains.integrations.consumers.stream_entrypoint"]
  }

  domain_functions_enabled = var.bootstrap_image_tag != ""

  lambda_domains = local.domain_functions_enabled ? local.lambda_domains_declared : {}

  dynamodb_domain_write_actions = [
    "dynamodb:BatchGetItem",
    "dynamodb:BatchWriteItem",
    "dynamodb:ConditionCheckItem",
    "dynamodb:DeleteItem",
    "dynamodb:DescribeTable",
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:Query",
    "dynamodb:Scan",
    "dynamodb:TransactGetItems",
    "dynamodb:TransactWriteItems",
    "dynamodb:UpdateItem",
  ]

  dynamodb_domain_read_actions = [
    "dynamodb:BatchGetItem",
    "dynamodb:DescribeTable",
    "dynamodb:GetItem",
    "dynamodb:Query",
    "dynamodb:Scan",
  ]

  identity_owned_tables = ["api-keys", "share-tokens"]

  lambda_domain_write_arns = {
    for name, domain in local.lambda_domains : name => flatten([
      for table in setsubtract(domain.tables, local.identity_owned_tables) : [
        module.dynamodb.table_arns[table],
        "${module.dynamodb.table_arns[table]}/index/*",
      ]
    ])
  }

  lambda_domain_read_arns = {
    for name, domain in local.lambda_domains : name => flatten([
      for table in setsubtract(domain.read_tables, local.identity_owned_tables) : [
        module.dynamodb.table_arns[table],
        "${module.dynamodb.table_arns[table]}/index/*",
      ]
    ])
  }

  lambda_domain_environment = {
    for name, domain in local.lambda_domains : name => merge(
      {
        DEBUG                 = "false"
        APP_ENVIRONMENT       = var.environment
        DYNAMODB_TABLE_PREFIX = local.prefix

        RATE_LIMITS_TABLE = module.dynamodb.table_names["rate-limits"]

        FRONTEND_URL    = local.frontend_url
        API_URL         = local.api_url
        ALLOWED_ORIGINS = local.allowed_origins

        WEBBPULSE_OTEL_SAMPLE_RATIO        = var.environment == "production" ? "0.1" : "1.0"
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "https://xray.${var.aws_region}.amazonaws.com/v1/traces"

        IDENTITY_ISSUER   = local.identity_issuer
        IDENTITY_AUDIENCE = local.identity_audience
        IDENTITY_JWKS_URL = "${local.identity_issuer}/.well-known/jwks.json"
      },
      domain.secrets ? { APP_SECRETS_ARN = module.app_secrets.arns["app"] } : {},

      name == "discussion" ? { ATTACHMENTS_BUCKET = module.attachments_bucket.bucket_id } : {},

      startswith(name, "integrations") ? {
        GITHUB_APP_SLUG            = var.github_app_slug
        GITHUB_EVENTS_QUEUE_URL    = local.github_queues_enabled ? module.github_events_queue[0].queue_url : ""
        WEBHOOK_DISPATCH_QUEUE_URL = local.github_queues_enabled ? module.webhook_dispatch_queue[0].queue_url : ""
      } : {},

      domain.ses ? {
        EMAIL_FROM    = local.email_from
        EMAIL_ENABLED = "true"
      } : {},

      name == "identity" ? merge({
        IDENTITY_ENVIRONMENT       = var.environment
        IDENTITY_PRODUCT_NAME      = "Standupless"
        IDENTITY_RP_NAME           = "Standupless"
        IDENTITY_SUPPORT_EMAIL     = "support@${local.active_domain}"
        IDENTITY_FRONTEND_BASE_URL = local.frontend_url

        IDENTITY_EMAIL_FROM            = local.email_from
        IDENTITY_SES_CONFIGURATION_SET = aws_sesv2_configuration_set.transactional.configuration_set_name

        IDENTITY_REGISTRATION_ENABLED = "true"

        IDENTITY_TOTP_CIPHER = "secret"

        IDENTITY_EPHEMERAL_USERS_ENABLED = tostring(var.ephemeral_users_enabled)

        IDENTITY_PASSKEYS_ENABLED      = tostring(var.passkeys_enabled)
        IDENTITY_PASSKEYS_PASSWORDLESS = tostring(var.passkeys_passwordless)

        IDENTITY_WEBAUTHN_ORIGINS = local.identity_webauthn_origins

        IDENTITY_OAUTH_REDIRECT_URIS = local.identity_oauth_redirect_uris
        IDENTITY_GOOGLE_CLIENT_ID    = var.oauth_google_client_id
        IDENTITY_GITHUB_CLIENT_ID    = var.oauth_github_client_id
        },

      module.identity.identity_environment) : {},
    )
  }

  issues_stream_enabled = local.domain_functions_enabled && var.issues_stream_enabled

  views_notify_stream_enabled = local.domain_functions_enabled && var.views_notify_stream_enabled

  views_search_stream_enabled = local.domain_functions_enabled && var.views_search_stream_enabled

  planning_rollup_stream_enabled = local.domain_functions_enabled && var.planning_rollup_stream_enabled

  lambda_domain_stream_defaults = {
    starting_position                  = "LATEST"
    batch_size                         = 100
    maximum_batching_window_in_seconds = 5
    bisect_batch_on_function_error     = true
    maximum_retry_attempts             = 3
  }

  integrations_stream_enabled = local.domain_functions_enabled && var.integrations_stream_enabled

  lambda_domain_sqs_sources = {
    for name in keys(local.lambda_domains) : name => (
      name == "integrations-events-consumer" && local.github_queues_enabled ? {
        github-events = {
          queue_arn                          = module.github_events_queue[0].queue_arn
          batch_size                         = 10
          maximum_batching_window_in_seconds = 5
          maximum_concurrency                = 20
        }
        } : name == "integrations-dispatch-consumer" && local.github_queues_enabled ? {
        webhook-dispatch = {
          queue_arn                          = module.webhook_dispatch_queue[0].queue_arn
          batch_size                         = 10
          maximum_batching_window_in_seconds = 5
          maximum_concurrency                = 10
        }
      } : {}
    )
  }

  lambda_domain_stream_sources = {
    for name in keys(local.lambda_domains) : name => (
      name == "issues" && local.issues_stream_enabled ? {
        rollup = merge(local.lambda_domain_stream_defaults, {
          stream_arn      = module.dynamodb.stream_arns["issues"]
          filter_patterns = [jsonencode({ eventName = ["INSERT", "MODIFY", "REMOVE"] })]
        })
        } : name == "views-notify-consumer" && local.views_notify_stream_enabled ? {
        issues = merge(local.lambda_domain_stream_defaults, {
          stream_arn      = module.dynamodb.stream_arns["issues"]
          filter_patterns = [jsonencode({ eventName = ["INSERT", "MODIFY"] })]
        })
        comments = merge(local.lambda_domain_stream_defaults, {
          stream_arn      = module.dynamodb.stream_arns["comments"]
          filter_patterns = [jsonencode({ eventName = ["INSERT", "MODIFY"] })]
        })
        } : name == "views-search-consumer" && local.views_search_stream_enabled ? {
        issues = merge(local.lambda_domain_stream_defaults, {
          stream_arn      = module.dynamodb.stream_arns["issues"]
          filter_patterns = [jsonencode({ eventName = ["INSERT", "MODIFY", "REMOVE"] })]
        })
        } : name == "planning-rollup-consumer" && local.planning_rollup_stream_enabled ? {
        issues = merge(local.lambda_domain_stream_defaults, {
          stream_arn      = module.dynamodb.stream_arns["issues"]
          filter_patterns = [jsonencode({ eventName = ["INSERT", "MODIFY", "REMOVE"] })]
        })
        } : name == "integrations-stream-consumer" && local.integrations_stream_enabled ? {
        issues = merge(local.lambda_domain_stream_defaults, {
          stream_arn      = module.dynamodb.stream_arns["issues"]
          filter_patterns = [jsonencode({ eventName = ["INSERT", "MODIFY"] })]
        })
        comments = merge(local.lambda_domain_stream_defaults, {
          stream_arn      = module.dynamodb.stream_arns["comments"]
          filter_patterns = [jsonencode({ eventName = ["INSERT"] })]
        })
      } : {}
    )
  }
}

variable "views_notify_stream_enabled" {
  description = "Whether the issues and comments table streams are wired to the views notify consumer. Off by default for the same reason issues_stream_enabled is: the tables, the consumer route and this wiring land first, and the mapping is switched on once the views image is deployed and both consumer functions are serving their pass-through path. A literal boolean rather than a test on the stream ARNs, because those are unknown on a fresh account's first plan and Terraform refuses an unknown map key."
  type        = bool
  default     = false
}

variable "views_search_stream_enabled" {
  description = "Whether the issues table stream is wired to the views search consumer, which maintains the search_index term projection. Held apart from views_notify_stream_enabled so the search projection can be backfilled and switched on independently of notifications, since turning it on mid-life leaves issues written before it indexed only once they are next edited."
  type        = bool
  default     = false
}

variable "planning_rollup_stream_enabled" {
  description = "Whether the issues table's stream is wired to the planning rollup consumer, which maintains the issue counts on every cycle and milestone row. Off by default for the same reason the other stream flags are: the table, the consumer route and this wiring land first, and the mapping is switched on once the planning image is deployed and the consumer function is serving its pass-through path. Turning it on mid-life leaves counts that predate it at zero until each issue is next written, so a backfill belongs with the switch. A literal boolean rather than a test on the stream ARN, because that ARN is unknown on a fresh account's first plan and Terraform refuses an unknown map key."
  type        = bool
  default     = false
}

variable "issues_stream_enabled" {
  description = "Whether the issues table's stream is wired to the issues function's rollup consumer through the lambda-function module's dynamodb_stream_event_sources input. Off by default so the table, the consumer route and this wiring can land before the mapping is switched on, and so an account applying before the issues image exists is not left with a mapping pointing at no function. It is a literal boolean rather than a test on the stream ARN because the ARN is unknown on a fresh account's first plan and Terraform refuses an unknown map key outright. Turn it on once the issues function is deployed and serving its pass-through path."
  type        = bool
  default     = false
}

variable "bootstrap_image_tag" {
  description = "Image tag every per-domain function is seeded from, as pushed to ECR by the container image build. Lambda resolves the tag during CreateFunction, so it must already exist in each domain's repository before the apply. The empty string resolves the domain map to empty, which is how a fresh account applies once with no images in ECR."
  type        = string
  default     = ""

  validation {
    condition     = var.bootstrap_image_tag == "" || can(regex("^sha-[0-9a-f]{40}$", var.bootstrap_image_tag))
    error_message = "bootstrap_image_tag must be sha- followed by a full 40 character commit sha, which is the tag the container image build pushes, or the empty string to bootstrap an account whose ECR repositories hold no images yet."
  }
}

module "lambda_domain" {
  for_each = local.lambda_domains

  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/lambda-function"
  version = "~> 2.27"

  function_name = "${local.prefix}-${each.key}"
  role_name     = "${local.prefix}-lambda-${each.key}"

  package_type = "Image"

  architectures = ["arm64"]
  memory_size   = each.value.memory

  timeout = 29

  code = {
    image_uri = "${module.registry.repository_urls[lookup(local.lambda_domain_images, each.key, each.key)]}:${var.bootstrap_image_tag}"
  }

  image_config = contains(keys(local.lambda_domain_commands), each.key) ? {
    command = local.lambda_domain_commands[each.key]
  } : null

  environment_variables = local.lambda_domain_environment[each.key]

  dynamodb_stream_event_sources = local.lambda_domain_stream_sources[each.key]

  sqs_event_sources = local.lambda_domain_sqs_sources[each.key]

  log_retention_days           = 7
  log_format                   = "JSON"
  application_log_level        = "INFO"
  system_log_level             = "INFO"
  set_logging_config_log_group = true

  tracing_mode             = "Active"
  attach_xray_write_policy = true

  tags = { Name = "${local.prefix}-${each.key}" }
}

resource "aws_iam_role_policy" "lambda_domain" {
  for_each = local.lambda_domains

  name = "${each.key}-runtime"
  role = module.lambda_domain[each.key].role_id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "WriteOwnLogs"
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
          Resource = "${module.lambda_domain[each.key].log_group_arn}:*"
        },
        {
          Sid      = "WriteSpansToTheXRayOTLPEndpoint"
          Effect   = "Allow"
          Action   = ["xray:PutSpans", "xray:PutSpansForIndexing"]
          Resource = "*"
        },
      ],
      length(local.lambda_domain_write_arns[each.key]) > 0 ? [
        {
          Sid      = "ReadWriteOwnTables"
          Effect   = "Allow"
          Action   = local.dynamodb_domain_write_actions
          Resource = local.lambda_domain_write_arns[each.key]
        },
      ] : [],
      length(local.lambda_domain_read_arns[each.key]) > 0 ? [
        {
          Sid      = "ReadSharedTables"
          Effect   = "Allow"
          Action   = local.dynamodb_domain_read_actions
          Resource = local.lambda_domain_read_arns[each.key]
        },
      ] : [],
      each.value.secrets ? [
        {
          Sid      = "ReadTheAppSecret"
          Effect   = "Allow"
          Action   = ["secretsmanager:GetSecretValue"]
          Resource = [module.app_secrets.arns["app"]]
        },
      ] : [],
      each.key == "discussion" ? [
        {
          Sid      = "ReadWriteAttachmentObjects"
          Effect   = "Allow"
          Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
          Resource = ["${module.attachments_bucket.bucket_arn}/*"]
        },
      ] : [],
      each.value.ses ? [
        {
          Sid    = "SendTransactionalMail"
          Effect = "Allow"
          Action = ["ses:SendEmail"]
          Resource = [
            "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/*",
            "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:configuration-set/${aws_sesv2_configuration_set.transactional.configuration_set_name}",
          ]
        },
      ] : [],
    )
  })
}
