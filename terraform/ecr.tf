locals {
  lambda_domain_names = [
    "identity",
    "workspaces",
    "teams",
    "issues",
    "discussion",
    "views",
    "planning",
    "integrations",
    "admin",
  ]
}

module "registry" {
  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/ecr-repository"
  version = "~> 2.27"

  name_prefix = local.prefix

  keep_last_tagged_images = 3

  repositories = merge(
    { for domain in local.lambda_domain_names : domain => {} },
    var.environment == "staging" ? { projects = {} } : {},
  )
}
