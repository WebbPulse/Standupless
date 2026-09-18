/**
 * The bucket issue attachments are uploaded to and downloaded from.
 *
 * Private with every public access block on, which the module does by default.
 * Nothing is ever served from this origin: the browser reaches an object only
 * through a presigned URL the discussion function mints per request, so a bucket
 * that is readable by nobody is the whole access model rather than a hardening
 * step on top of one.
 *
 * SSE-S3 rather than a customer managed key. A KMS key bills every GET and PUT,
 * and an attachment bucket is read far more often than state is; the objects are
 * already reachable only through a short-lived signature.
 */
module "attachments_bucket" {
  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/s3-bucket"
  version = "~> 2.25"

  bucket = "${local.prefix}-attachments-${data.aws_caller_identity.current.account_id}"

  force_destroy = var.environment != "production"

  # CORS is what makes the browser PUT legal. The upload goes straight from the
  # page to S3, so the bucket rather than the API is what has to answer the
  # preflight, and ETag is exposed because that is what the client reads back to
  # confirm the object it just wrote.
  cors_rules = [
    {
      id              = "browser-upload"
      allowed_methods = ["PUT", "GET", "HEAD"]
      allowed_origins = local.browser_origins
      allowed_headers = ["*"]
      expose_headers  = ["ETag"]
      max_age_seconds = 3600
    },
  ]

  # The contract fixes one object key for an upload and leaves a deleted
  # attachment's object to the bucket, so there is no prefix that distinguishes a
  # committed object from an abandoned one and no expiry that could sweep the
  # second without eventually deleting the first. Orphans are therefore bounded by
  # the 25 MiB per-object ceiling rather than collected on a timer, and a real
  # sweep needs a reconciler that reads the `attachments` table, which is a
  # separate piece of work rather than a lifecycle rule.
  lifecycle_rules = {
    abort-stalled-uploads = {
      abort_incomplete_multipart_upload_days = 1
    }

    expire-superseded-objects = {
      noncurrent_version_expiration_days = 7
      newer_noncurrent_versions          = 1
    }
  }
}
