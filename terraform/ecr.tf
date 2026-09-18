locals {
  lambda_domain_names = [
    "identity",
    "workspaces",
    "projects",
  ]
}

module "registry" {
  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/ecr-repository"
  version = "~> 2.22"

  name_prefix = local.prefix

  keep_last_tagged_images = 3

  repositories = { for domain in local.lambda_domain_names : domain => {} }
}
