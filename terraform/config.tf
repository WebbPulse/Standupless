module "config" {
  source  = "terraform.webbpulse.com/WebbPulse/platform-modules/aws//modules/operator-config"
  version = "~> 2.30"

  name_prefix = local.prefix
}

import {
  to = module.config.aws_ssm_parameter.this
  id = "/${local.prefix}/config"
}

locals {
  ses_verified_recipients = try(module.config.values.ses_verified_recipients, [])
}
