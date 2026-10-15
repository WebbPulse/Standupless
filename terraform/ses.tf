module "ses" {
  source  = "terraform.webbpulse.com/WebbPulse/platform-modules/aws//modules/ses-identity"
  version = "~> 2.39"

  configuration_set_name = "standupless-transactional"

  domain           = local.custom_domain ? local.domain_name : null
  sender_address   = local.custom_domain ? null : local.email_from
  mail_from_domain = local.custom_domain ? "bounce.${local.domain_name}" : null

  dkim_records_zone_id     = local.custom_domain ? module.staging_dns.zone_id : null
  create_mail_from_records = local.custom_domain

  verified_recipients = local.ses_verified_recipients

  tags           = { Name = "${local.prefix}-ses-domain" }
  recipient_tags = { Name = "${local.prefix}-ses-recipient" }
}

moved {
  from = aws_sesv2_configuration_set.transactional
  to   = module.ses.aws_sesv2_configuration_set.this
}

moved {
  from = aws_sesv2_email_identity.domain[0]
  to   = module.ses.aws_sesv2_email_identity.domain[0]
}

moved {
  from = aws_sesv2_email_identity.sender[0]
  to   = module.ses.aws_sesv2_email_identity.sender[0]
}

moved {
  from = aws_sesv2_email_identity_mail_from_attributes.domain[0]
  to   = module.ses.aws_sesv2_email_identity_mail_from_attributes.domain[0]
}

moved {
  from = aws_sesv2_email_identity_feedback_attributes.domain[0]
  to   = module.ses.aws_sesv2_email_identity_feedback_attributes.domain[0]
}

moved {
  from = aws_sesv2_email_identity.recipient
  to   = module.ses.aws_sesv2_email_identity.recipient
}

moved {
  from = aws_route53_record.ses_mail_from_mx[0]
  to   = module.ses.aws_route53_record.mail_from_mx[0]
}

moved {
  from = aws_route53_record.ses_mail_from_spf[0]
  to   = module.ses.aws_route53_record.mail_from_spf[0]
}
