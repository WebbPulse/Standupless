locals {
  dynamodb_table_specs = jsondecode(file("${path.module}/dynamodb_tables.json"))

  dynamodb_tables = {
    for name, spec in local.dynamodb_table_specs :
    name => merge(spec, {
      point_in_time_recovery = name == "rate-limits" ? false : null

      stream_view_type = lookup(
        local.dynamodb_stream_view_types,
        name,
        lookup(spec, "stream_view_type", null),
      )
    })
  }

  # The backend's table specs carry stream_view_type through dynamodb_tables.json,
  # so a table whose own code declares a stream needs no entry here. This map is
  # only for a stream nothing in the backend declares, which is the users table:
  # its stream feeds the identity package's purge consumer rather than a repository.
  dynamodb_stream_view_types = {
    users = "KEYS_ONLY"
  }
}

module "dynamodb" {
  source = "app.terraform.io/WebbPulse/platform-modules/aws//modules/dynamodb-tables"

  version = "~> 2.27"

  name_prefix = local.prefix
  tables      = local.dynamodb_tables

  point_in_time_recovery = var.environment == "production"
  deletion_protection    = var.environment == "production"
  name_tag               = true
}
