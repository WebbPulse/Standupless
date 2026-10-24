module "staging_dns" {
  source  = "terraform.webbpulse.com/WebbPulse/platform-modules/aws//modules/staging-dns"
  version = "~> 2.45"

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

import {
  for_each = var.environment == "production" ? toset(["Z0959274HZA1YYG39XL2"]) : toset([])

  to = module.staging_dns.aws_route53_zone.this[0]
  id = each.value
}
