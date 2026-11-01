identity_jwt_mode   = "gate"
domain_jwt_enforced = true

passkeys_enabled       = true
passkeys_passwordless  = true
passkeys_second_factor = true

ephemeral_users_enabled = true
adopt_spans_log_group   = true

billing_enabled                  = true
billing_business_enabled         = true
plan_limit_e2e_exemption_enabled = true
identity_e2e_user_ids            = ["c52c681e-019c-4c31-9866-a4538997bd80"]

github_app_slug       = "standupless-staging"
github_queues_enabled = true

issues_stream_enabled          = true
integrations_stream_enabled    = true
views_notify_stream_enabled    = true
views_search_stream_enabled    = true
planning_rollup_stream_enabled = true

team_purge_enabled = true

workspace_export_enabled = true

issue_import_enabled = true

email_intake_enabled = true

oauth_github_client_id = "Ov23li7DuxrwV5286wDv"
oauth_google_client_id = "1001009632870-3frfpiq3sbvb60jpv7p4jaempf6uomh9.apps.googleusercontent.com"

desktop_handoff_schemes = ["standupless-staging"]

slack_config_role_arn = "arn:aws:iam::147741822161:role/standupless-production-slack-config"
