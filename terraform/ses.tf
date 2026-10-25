module "ses" {
  source  = "terraform.webbpulse.com/WebbPulse/platform-modules/aws//modules/ses-identity"
  version = "~> 2.45"

  configuration_set_name = "standupless-transactional"

  domain           = local.custom_domain ? local.domain_name : null
  sender_address   = local.custom_domain ? null : local.email_from
  mail_from_domain = local.custom_domain ? "bounce.${local.domain_name}" : null

  dkim_records_zone_id     = local.custom_domain ? module.staging_dns.zone_id : null
  create_dkim_records      = local.custom_domain
  dkim_record_ttl          = 60
  dmarc_record             = local.custom_domain ? "v=DMARC1; p=none;" : null
  dmarc_record_ttl         = 60
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

moved {
  from = aws_route53_record.ses_dkim
  to   = module.ses.aws_route53_record.dkim
}

moved {
  from = aws_route53_record.dmarc
  to   = module.ses.aws_route53_record.dmarc
}

locals {
  email_intake_domain   = "intake.${local.domain_name}"
  email_intake_rule_set = "${local.prefix}-intake"
  email_intake_rule     = "store-intake-mail"
}

/**
 * Inbound mail for issue intake addresses.
 *
 * An account has one active receipt rule set per region, and neither account had
 * one, so this set is created and activated here. Any later receiving use adds a
 * rule to it rather than activating a second set. The intake subdomain inherits
 * its verification from the environment's domain identity above.
 */
resource "aws_ses_receipt_rule_set" "intake" {
  count = local.email_intake_enabled ? 1 : 0

  rule_set_name = local.email_intake_rule_set
}

resource "aws_ses_active_receipt_rule_set" "intake" {
  count = local.email_intake_enabled ? 1 : 0

  rule_set_name = aws_ses_receipt_rule_set.intake[0].rule_set_name
}

/**
 * Stores every message to the intake subdomain and lets the consumer decide.
 *
 * Spam and virus scanning is on so the consumer can drop a message on the verdict
 * headers SES prepends, and TLS is required of the sending server. Nothing here
 * bounces or replies: the product never mails a sender back.
 */
resource "aws_ses_receipt_rule" "intake" {
  count = local.email_intake_enabled ? 1 : 0

  name          = local.email_intake_rule
  rule_set_name = aws_ses_receipt_rule_set.intake[0].rule_set_name
  recipients    = [local.email_intake_domain]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Require"

  s3_action {
    position          = 1
    bucket_name       = module.email_intake_bucket[0].bucket_id
    object_key_prefix = "inbound/"
  }

  depends_on = [module.email_intake_bucket]
}
