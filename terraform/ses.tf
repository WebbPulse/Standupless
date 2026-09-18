resource "aws_sesv2_configuration_set" "transactional" {
  configuration_set_name = "standupless-transactional"

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  tags = { Name = "${local.prefix}-transactional" }
}

resource "aws_sesv2_email_identity" "domain" {
  count = local.custom_domain ? 1 : 0

  email_identity         = local.domain_name
  configuration_set_name = aws_sesv2_configuration_set.transactional.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }

  tags = { Name = "${local.prefix}-ses-domain" }
}

resource "aws_sesv2_email_identity" "sender" {
  count = local.custom_domain ? 0 : 1

  email_identity         = local.email_from
  configuration_set_name = aws_sesv2_configuration_set.transactional.configuration_set_name

  tags = { Name = "${local.prefix}-ses-sender" }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  count = local.custom_domain ? 1 : 0

  email_identity         = aws_sesv2_email_identity.domain[0].email_identity
  mail_from_domain       = "bounce.${local.domain_name}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_sesv2_email_identity_feedback_attributes" "domain" {
  count = local.custom_domain ? 1 : 0

  email_identity           = aws_sesv2_email_identity.domain[0].email_identity
  email_forwarding_enabled = false
}
