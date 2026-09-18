locals {
  artifacts_account_id = "432410731887"

  codeartifact_domain = "webbpulse"

  codeartifact_domain_arn = "arn:aws:codeartifact:${var.aws_region}:${local.artifacts_account_id}:domain/${local.codeartifact_domain}"

  codeartifact_repository_arns = [
    for repository in ["npm", "npm-store", "pypi-store", "python", "shared"] :
    "arn:aws:codeartifact:${var.aws_region}:${local.artifacts_account_id}:repository/${local.codeartifact_domain}/${repository}"
  ]

  codeartifact_package_arns = [
    for repository in ["npm", "npm-store", "pypi-store", "python", "shared"] :
    "arn:aws:codeartifact:${var.aws_region}:${local.artifacts_account_id}:package/${local.codeartifact_domain}/${repository}/*"
  ]

  shared_base_image_repository_arn = "arn:aws:ecr:us-west-2:${local.artifacts_account_id}:repository/webbpulse/python-lambda-base"

  lambda_domain_function_arns = [
    for domain in sort(local.lambda_domain_names) :
    "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.prefix}-${domain}"
  ]

  codeartifact_read_policy_statements = [
    {
      sid       = "CodeArtifactToken"
      actions   = ["codeartifact:GetAuthorizationToken"]
      resources = [local.codeartifact_domain_arn]
    },
    {
      sid = "CodeArtifactRead"
      actions = [
        "codeartifact:DescribePackageVersion",
        "codeartifact:DescribeRepository",
        "codeartifact:GetPackageVersionAsset",
        "codeartifact:GetPackageVersionReadme",
        "codeartifact:GetRepositoryEndpoint",
        "codeartifact:ListPackageVersionAssets",
        "codeartifact:ListPackageVersionDependencies",
        "codeartifact:ListPackageVersions",
        "codeartifact:ListPackages",
        "codeartifact:ReadFromRepository",
      ]
      resources = concat(local.codeartifact_repository_arns, local.codeartifact_package_arns)
    },
    {
      sid       = "CodeArtifactBearerToken"
      actions   = ["sts:GetServiceBearerToken"]
      resources = ["*"]
      condition = {
        StringEquals = {
          "sts:AWSServiceName" = ["codeartifact.amazonaws.com"]
        }
      }
    },
  ]

  shared_registry_policy_statements = concat(local.codeartifact_read_policy_statements, [
    {
      sid = "SharedBaseImagePull"
      actions = [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:DescribeImages",
        "ecr:GetDownloadUrlForLayer",
      ]
      resources = [local.shared_base_image_repository_arn]
    },
    {
      sid       = "SharedBaseImageAuth"
      actions   = ["ecr:GetAuthorizationToken"]
      resources = ["*"]
    },
    {
      sid = "EcrPushDomainImages"
      actions = [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:BatchGetImage",
        "ecr:DescribeImages",
        "ecr:GetDownloadUrlForLayer",
        "ecr:GetRepositoryPolicy",
        "ecr:SetRepositoryPolicy",
      ]
      resources = module.registry.repository_arns_list
    },
  ])

  gate_policy_statements = [
    for statement in [
      {
        sid     = "GateParameterRead"
        actions = ["ssm:GetParameter"]
        resources = [
          one(module.staging_access_gate[*].origin_verify_ssm_parameter_arn),
          one(module.staging_access_gate[*].signing_key_ssm_parameter_arn),
        ]
      },
      {
        sid       = "E2EDecryptGateParameter"
        actions   = ["kms:Decrypt"]
        resources = ["*"]
        condition = {
          StringEquals = {
            "kms:ViaService" = ["ssm.${var.aws_region}.amazonaws.com"]
          }
        }
      },
    ] : statement if local.staging_gate_enabled
  ]

  e2e_signing_policy_statements = [
    for statement in [
      {
        sid       = "E2EMintStagingIdentityToken"
        actions   = ["kms:Sign", "kms:GetPublicKey"]
        resources = local.identity_signing_key_arns
      },
    ] : statement if var.environment == "staging"
  ]
}

module "github_actions_role" {
  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/github-actions-role"
  version = "~> 2.22"

  role_name = "${local.prefix}-github-actions-deploy"
  subjects  = ["repo:WebbPulse/Standupless:*"]

  policy_statements = concat(
    [
      {
        actions = [
          "lambda:UpdateFunctionCode",
          "lambda:PublishVersion",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:GetFunctionCodeSigningConfig",
        ]
        resources = local.lambda_domain_function_arns
      },
      {
        actions   = ["lambda:InvokeFunction"]
        resources = local.lambda_domain_function_arns
      },
      {
        actions   = ["logs:FilterLogEvents"]
        resources = ["arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/apigateway/${local.prefix}-api:*"]
      },
      {
        sid     = "E2EReadGatewayRoutes"
        actions = ["apigateway:GET"]
        resources = [
          "arn:aws:apigateway:${var.aws_region}::/apis/${module.api.api_id}",
          "arn:aws:apigateway:${var.aws_region}::/apis/${module.api.api_id}/*",
        ]
      },
      {
        actions = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:ListBucket",
        ]
        resources = [
          module.frontend.bucket_arn,
          "${module.frontend.bucket_arn}/*",
        ]
      },
      {
        actions = [
          "cloudfront:CreateInvalidation",
          "cloudfront:GetInvalidation",
        ]
        resources = [module.frontend.distribution_arn]
      },
    ],
    local.gate_policy_statements,
    local.e2e_signing_policy_statements,
    local.shared_registry_policy_statements,
  )
}

module "github_actions_ci_role" {
  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/github-actions-role"
  version = "~> 2.22"

  role_name        = "${local.prefix}-github-actions-ci"
  role_description = "Read only CodeArtifact access for pull request CI in WebbPulse/Standupless. Deploy permissions live on the separate github-actions-deploy role."

  create_oidc_provider = false
  oidc_provider_arn    = module.github_actions_role.oidc_provider_arn

  subjects = [
    "repo:WebbPulse/Standupless:pull_request",
    "repo:WebbPulse/Standupless:ref:refs/heads/staging",
    "repo:WebbPulse/Standupless:ref:refs/heads/main",
  ]

  inline_policy_name = "codeartifact-read"

  policy_statements = local.codeartifact_read_policy_statements
}
