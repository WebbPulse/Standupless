resource "aws_cloudfront_function" "frontend_uri_rewrite" {
  name    = "${local.prefix}-frontend-uri-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Redirect www to apex and rewrite extensionless paths to index.html."
  publish = true

  code = templatefile("${path.module}/cloudfront_functions/uri_rewrite.js.tftpl", {
    app_handler = templatefile("${path.module}/cloudfront_functions/app_handler.js.tftpl", { domain = local.active_domain })
  })
}
