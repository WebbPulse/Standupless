locals {
  com_redirect_enabled = var.environment == "production"
  com_redirect_count   = local.com_redirect_enabled ? 1 : 0

  com_redirect_zone_name = "standupless.com"
  com_redirect_zone_id   = "Z0554059HC46DBHOBAAU"
  com_redirect_hosts     = toset([local.com_redirect_zone_name, "www.${local.com_redirect_zone_name}"])
  com_redirect_records = local.com_redirect_enabled ? {
    for pair in setproduct(local.com_redirect_hosts, ["A", "AAAA"]) : "${pair[0]} ${pair[1]}" => {
      name = pair[0]
      type = pair[1]
    }
  } : {}
}

import {
  for_each = local.com_redirect_enabled ? toset([local.com_redirect_zone_id]) : toset([])

  to = aws_route53_zone.com_redirect[0]
  id = each.value
}

resource "aws_route53_zone" "com_redirect" {
  count = local.com_redirect_count

  name    = local.com_redirect_zone_name
  comment = "HostedZone created by Route53 Registrar"
}

module "com_redirect_certificate" {
  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/acm-certificate"
  version = "~> 2.27"

  providers = {
    aws         = aws.us_east_1
    aws.records = aws
  }

  enabled                   = local.com_redirect_enabled
  domain_name               = local.com_redirect_zone_name
  subject_alternative_names = ["www.${local.com_redirect_zone_name}"]
  zone_id                   = one(aws_route53_zone.com_redirect[*].zone_id)
}

resource "aws_cloudfront_function" "com_redirect" {
  count = local.com_redirect_count

  name    = "${local.prefix}-com-redirect"
  runtime = "cloudfront-js-2.0"
  comment = "301 redirect from ${local.com_redirect_zone_name} to ${local.domain_name}, preserving path and query."
  publish = true
  code    = templatefile("${path.module}/cloudfront_functions/com_redirect.js.tftpl", { target_domain = local.domain_name })
}

resource "aws_cloudfront_distribution" "com_redirect" {
  count = local.com_redirect_count

  enabled         = true
  is_ipv6_enabled = true
  comment         = "${local.prefix} ${local.com_redirect_zone_name} redirect"
  aliases         = sort(tolist(local.com_redirect_hosts))
  price_class     = "PriceClass_100"
  http_version    = "http2and3"

  origin {
    domain_name = local.domain_name
    origin_id   = "${local.prefix}-com-redirect-target"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "${local.prefix}-com-redirect-target"
    viewer_protocol_policy = "allow-all"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.com_redirect[0].arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = module.com_redirect_certificate.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Name = "${local.prefix}-com-redirect" }
}

resource "aws_route53_record" "com_redirect" {
  for_each = local.com_redirect_records

  zone_id = aws_route53_zone.com_redirect[0].zone_id
  name    = each.value.name
  type    = each.value.type

  alias {
    name                   = aws_cloudfront_distribution.com_redirect[0].domain_name
    zone_id                = aws_cloudfront_distribution.com_redirect[0].hosted_zone_id
    evaluate_target_health = false
  }
}
