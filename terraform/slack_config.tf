locals {
  slack_config_enabled = var.environment == "production"
  slack_config_count   = local.slack_config_enabled ? 1 : 0

  slack_config_role_name = "${local.prefix}-slack-config"

  slack_config_role_arn = local.slack_config_enabled ? "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.slack_config_role_name}" : var.slack_config_role_arn

  slack_config_assume_policy_statements = local.slack_config_role_arn == null ? [] : [
    {
      sid       = "AssumeSlackConfigRole"
      actions   = ["sts:AssumeRole"]
      resources = [local.slack_config_role_arn]
    },
  ]

  slack_config_value_actions = [
    "secretsmanager:GetSecretValue",
    "secretsmanager:PutSecretValue",
  ]
}

resource "aws_secretsmanager_secret" "slack_config" {
  count = local.slack_config_count

  name                    = "${local.prefix}/slack-config"
  description             = "Slack App configuration refresh token for both environments, key SLACK_CONFIG_REFRESH_TOKEN. scripts/apply_slack_manifest.py rotates it on every run and writes the successor back; only the slack-config role and AdministratorAccess may read or write the value."
  recovery_window_in_days = 7
}

data "aws_iam_policy_document" "slack_config_secret" {
  count = local.slack_config_count

  statement {
    sid       = "DenyValueAccessOutsideSlackConfigRole"
    effect    = "Deny"
    actions   = local.slack_config_value_actions
    resources = ["*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "ArnNotLike"
      variable = "aws:PrincipalArn"
      values = [
        local.slack_config_role_arn,
        "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_AdministratorAccess_*",
      ]
    }
  }
}

resource "aws_secretsmanager_secret_policy" "slack_config" {
  count = local.slack_config_count

  secret_arn          = aws_secretsmanager_secret.slack_config[0].arn
  policy              = data.aws_iam_policy_document.slack_config_secret[0].json
  block_public_policy = true
}

data "aws_iam_policy_document" "slack_config_trust" {
  count = local.slack_config_count

  statement {
    sid     = "DeployRolesAssume"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = distinct(concat([module.github_actions_role.role_arn], var.slack_config_trusted_role_arns))
    }
  }
}

resource "aws_iam_role" "slack_config" {
  count = local.slack_config_count

  name                 = local.slack_config_role_name
  description          = "Assumed by the staging and production deploy roles to apply Slack App manifests. Reads and writes only the slack-config secret."
  assume_role_policy   = data.aws_iam_policy_document.slack_config_trust[0].json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "slack_config_access" {
  count = local.slack_config_count

  statement {
    sid       = "SlackConfigSecretValue"
    actions   = local.slack_config_value_actions
    resources = [aws_secretsmanager_secret.slack_config[0].arn]
  }
}

resource "aws_iam_role_policy" "slack_config" {
  count = local.slack_config_count

  name   = "slack-config-secret"
  role   = aws_iam_role.slack_config[0].id
  policy = data.aws_iam_policy_document.slack_config_access[0].json
}
