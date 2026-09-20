module "staging_dns" {
  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/staging-dns"
  version = "~> 2.27"

  providers = {
    aws        = aws
    aws.parent = aws.parent_dns
  }

  enabled        = local.custom_domain
  zone_name      = local.domain_name
  delegate       = local.parent_delegation
  parent_zone_id = var.parent_route53_zone_id
}

resource "aws_route53_record" "spf" {
  count = local.custom_domain ? 1 : 0

  zone_id = module.staging_dns.zone_id
  name    = local.domain_name
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "ses_dkim" {
  count = local.custom_domain ? 3 : 0

  zone_id = module.staging_dns.zone_id
  name    = "${aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${local.domain_name}"
  type    = "CNAME"
  ttl     = 60
  records = ["${aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_mx" {
  count = local.custom_domain ? 1 : 0

  zone_id = module.staging_dns.zone_id
  name    = "bounce.${local.domain_name}"
  type    = "MX"
  ttl     = 300
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_spf" {
  count = local.custom_domain ? 1 : 0

  zone_id = module.staging_dns.zone_id
  name    = "bounce.${local.domain_name}"
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "dmarc" {
  count = local.custom_domain ? 1 : 0

  zone_id = module.staging_dns.zone_id
  name    = "_dmarc.${local.domain_name}"
  type    = "TXT"
  ttl     = 60
  records = ["v=DMARC1; p=none;"]
}
