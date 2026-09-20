module "frontend" {
  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/spa-frontend"
  version = "~> 2.27"

  name                       = "${local.prefix}-frontend"
  origin_access_control_name = "${local.prefix}-frontend-oac"
  origin_id                  = "${local.prefix}-frontend-s3"
  bucket_policy_sid          = "AllowCloudFrontOAC"

  aliases             = local.custom_domain ? [local.domain_name, "www.${local.domain_name}"] : []
  acm_certificate_arn = module.certificate.certificate_arn

  viewer_request_function_arn = aws_cloudfront_function.frontend_uri_rewrite.arn

  origin_request_policy_id   = "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf"
  response_headers_policy_id = "67f7725c-6f97-4210-82d7-5512b31e9d03"

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

  create_dns_records = local.custom_domain
  zone_id            = module.staging_dns.zone_id
  dns_records = {
    apex = local.domain_name
    www  = "www.${local.domain_name}"
  }
}
