/**
 * Sources the frontend's Content-Security-Policy adds to the spa-frontend baseline.
 *
 * The script hashes cover the inline scripts in frontend/index.html (theme, accent
 * and text size, boot splash phase) and the ones src/prerender/document.ts writes (the
 * signed in resume redirect, and the stale guard of each of the seven
 * prerendered pages, whose hash embeds the page path). A change to any of them
 * changes its hash; under report_only that only logs a violation.
 *
 * The API origin is spelled from the domain rather than read from module.api,
 * whose CORS origins already depend on this distribution.
 *
 * The attachments bucket is listed in both host forms because presigned URLs
 * use the global s3.amazonaws.com host while regional ones may appear in time.
 */
locals {
  api_origin = local.custom_domain ? "https://api.${local.domain_name}" : "https://*.execute-api.${var.aws_region}.amazonaws.com"

  attachments_bucket_origins = [
    "https://${module.attachments_bucket.bucket_id}.s3.amazonaws.com",
    "https://${module.attachments_bucket.bucket_id}.s3.${var.aws_region}.amazonaws.com",
  ]

  frontend_inline_script_hashes = [
    "'sha256-CA5GmqIxPIosCNhtIYRq2uallsAeWsW7SHiVQ3PjyOY='",
    "'sha256-OJ51BiuphfP+CCkdfbfEQjk0YXcMl7sov6F3sFWxcno='",
    "'sha256-hPlJVYV04ts5jAK5M+zBzpirVVSdqVa4867rMqqtjSw='",
    "'sha256-7/80D4r4ucpgYeiI1HmNzb88iy+cYVm1gu3nv2axxH8='",
    "'sha256-aHeq0umUK6AtDNMDQ0RY0YvqRFR3YYji35k2ABaI/6M='",
    "'sha256-ChWfZNYpq0mUC+g91dI4j8XZsRTpPGYsqvn2r2hsON0='",
    "'sha256-ouafaCW7NY8n2lKq3jeiBh14cdz7gT2veexCzPtntMY='",
    "'sha256-PTuDwv46i7kmEzDGtfY2T+JFwNHS9Wxcpb2pOeAUMdY='",
    "'sha256-sPzfPNHQfqNsP+Y1/h5pToifvmVhLmykN+PjzZoRGls='",
    "'sha256-WzFm13Km/xTT5Nnqv/eZvRg5zFDyHXiRlwyFEtb6joo='",
  ]
}

module "frontend" {
  source  = "terraform.webbpulse.com/WebbPulse/platform-modules/aws//modules/spa-frontend"
  version = "~> 2.41"

  name                       = "${local.prefix}-frontend"
  origin_access_control_name = "${local.prefix}-frontend-oac"
  origin_id                  = "${local.prefix}-frontend-s3"
  bucket_policy_sid          = "AllowCloudFrontOAC"

  aliases             = local.custom_domain ? [local.domain_name, "www.${local.domain_name}"] : []
  acm_certificate_arn = module.certificate.certificate_arn

  viewer_request_function = {
    domain         = local.active_domain
    canonical_host = "apex"
  }

  origin_request_policy_id = "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf"

  security_headers = {
    content_security_policy = {
      mode        = "report_only"
      script_src  = local.frontend_inline_script_hashes
      connect_src = concat([local.api_origin], local.attachments_bucket_origins)
      img_src     = concat(["blob:", "https://avatars.githubusercontent.com"], local.attachments_bucket_origins)
      media_src   = concat(["blob:"], local.attachments_bucket_origins)
    }
  }

  distribution_tags = { Name = "${local.prefix}-frontend" }

  access_gate = local.staging_gate_enabled ? {
    key_group_id                                           = module.staging_access_gate[0].key_group_id
    viewer_request_function_arn                            = module.staging_access_gate[0].viewer_request_function_arn
    login_origin_domain_name                               = module.staging_access_gate[0].login_origin_domain_name
    login_origin_access_control_id                         = module.staging_access_gate[0].login_origin_access_control_id
    auth_path_pattern                                      = module.staging_access_gate[0].auth_path_pattern
    cache_policy_id_caching_disabled                       = module.staging_access_gate[0].cache_policy_id_caching_disabled
    origin_request_policy_id_all_viewer_except_host_header = module.staging_access_gate[0].origin_request_policy_id_all_viewer_except_host_header

    login_origin_id = "${local.prefix}-access-gate-login"
  } : null

  public_paths = [
    "/robots.txt",
    "/sitemap.xml",
    "/email-logo.png",
    "/.well-known/apple-app-site-association",
    "/.well-known/assetlinks.json",
  ]

  create_dns_records = local.custom_domain
  zone_id            = module.staging_dns.zone_id
  dns_records = {
    apex = local.domain_name
    www  = "www.${local.domain_name}"
  }
}

moved {
  from = aws_cloudfront_function.frontend_uri_rewrite
  to   = module.frontend.aws_cloudfront_function.viewer_request[0]
}
