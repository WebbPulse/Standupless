module "certificate" {
  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/acm-certificate"
  version = "~> 2.25"

  providers = {
    aws         = aws.us_east_1
    aws.records = aws
  }

  enabled     = local.custom_domain
  domain_name = local.domain_name
  subject_alternative_names = [
    "*.${local.domain_name}",
  ]
  zone_id = module.staging_dns.zone_id

  depends_on = [module.staging_dns]
}

module "api_certificate" {
  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/acm-certificate"
  version = "~> 2.25"

  providers = {
    aws         = aws
    aws.records = aws
  }

  enabled     = local.custom_domain
  domain_name = "api.${local.domain_name}"
  zone_id     = module.staging_dns.zone_id

  depends_on = [module.staging_dns]
}
