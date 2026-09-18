module "app_baseline" {
  source  = "app.terraform.io/WebbPulse/platform-modules/aws//modules/app-baseline"
  version = "~> 2.25"

  name                = local.prefix
  notification_emails = ["tyler@webbpulse.com", "tylert2610@gmail.com"]

  resource_group_description = "All Standupless managed resources"
  resource_group_tag_filters = {
    Project = [local.project]
  }

  budgets = {
    "monthly-warn"     = { limit_amount = "30" }
    "monthly-critical" = { limit_amount = "60" }
  }
}
