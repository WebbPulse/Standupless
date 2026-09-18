locals {
  lambda_domains_declared = {
    identity = {
      secrets     = true
      ses         = true
      memory      = 512
      tables      = ["users", "rate-limits"]
      read_tables = []
    }
    workspaces = {
      secrets     = false
      ses         = false
      memory      = 512
      tables      = ["workspaces", "memberships", "invites", "rate-limits"]
      read_tables = ["users"]
    }
    projects = {
      secrets     = false
      ses         = false
      memory      = 512
      tables      = ["projects", "project_config", "counters", "rate-limits"]
      read_tables = ["memberships", "workspaces", "users"]
    }
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

  lambda_domain_write_arns = {
    for name, domain in local.lambda_domains : name => flatten([
      for table in domain.tables : [
        module.dynamodb.table_arns[table],
        "${module.dynamodb.table_arns[table]}/index/*",
      ]
    ])
  }

  lambda_domain_read_arns = {
    for name, domain in local.lambda_domains : name => flatten([
      for table in domain.read_tables : [
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
  version = "~> 2.22"

  function_name = "${local.prefix}-${each.key}"
  role_name     = "${local.prefix}-lambda-${each.key}"

  package_type = "Image"

  architectures = ["arm64"]
  memory_size   = each.value.memory

  timeout = 29

  code = {
    image_uri = "${module.registry.repository_urls[each.key]}:${var.bootstrap_image_tag}"
  }

  environment_variables = local.lambda_domain_environment[each.key]

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
