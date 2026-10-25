/**
 * The bucket SES writes each inbound intake message to, raw.
 *
 * A message is only a hand-off: the consumer reads it, files the issue, copies any
 * attachment into the attachments bucket and deletes the object. The expiry is the
 * backstop for a message the consumer never finished, so a sender's mail is kept
 * for days rather than indefinitely. Versioning is suspended because there is
 * nothing to roll back to, and a noncurrent version would outlive the delete.
 *
 * SSE-S3, for the reason the attachments bucket gives. SES encrypts with the
 * bucket default when the S3 action names no KMS key.
 */
module "email_intake_bucket" {
  count = local.email_intake_enabled ? 1 : 0

  source  = "terraform.webbpulse.com/WebbPulse/platform-modules/aws//modules/s3-bucket"
  version = "~> 2.45"

  bucket = "${local.prefix}-email-intake-${data.aws_caller_identity.current.account_id}"

  force_destroy     = true
  versioning_status = "Suspended"

  extra_policy_statements = [
    {
      Sid       = "SesWritesInboundMail"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "s3:PutObject"
      Resource  = "arn:aws:s3:::${local.prefix}-email-intake-${data.aws_caller_identity.current.account_id}/inbound/*"
      Condition = {
        StringEquals = {
          "AWS:SourceAccount" = data.aws_caller_identity.current.account_id
          "AWS:SourceArn"     = "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:receipt-rule-set/${local.email_intake_rule_set}:receipt-rule/${local.email_intake_rule}"
        }
      }
    },
  ]

  lifecycle_rules = {
    expire-inbound-mail = {
      prefix                             = "inbound/"
      expiration_days                    = 3
      noncurrent_version_expiration_days = 1
    }
  }

  tags = { Name = "${local.prefix}-email-intake" }
}

resource "aws_s3_bucket_notification" "email_intake" {
  count = local.email_intake_enabled ? 1 : 0

  bucket = module.email_intake_bucket[0].bucket_id

  queue {
    id            = "inbound-mail"
    queue_arn     = module.email_intake_queue[0].queue_arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = "inbound/"
  }

  depends_on = [aws_sqs_queue_policy.email_intake]
}
