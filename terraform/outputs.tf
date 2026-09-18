output "aws_account_id" {
  description = "AWS account ID Terraform is deploying into"
  value       = data.aws_caller_identity.current.account_id
}

output "aws_region" {
  description = "AWS region being deployed to"
  value       = data.aws_region.current.region
}

output "cloudfront_domain" {
  description = "CloudFront distribution domain name"
  value       = module.frontend.distribution_domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID, needed for cache invalidations"
  value       = module.frontend.distribution_id
}

output "frontend_bucket" {
  description = "S3 bucket name for the frontend SPA"
  value       = module.frontend.bucket_name
}

output "domain_name" {
  description = "Domain this environment serves (null without a custom domain)"
  value       = local.custom_domain ? local.domain_name : null
}

output "route53_zone_id" {
  description = "Hosted zone id for domain_name (null without a custom domain)"
  value       = module.staging_dns.zone_id
}

output "route53_zone_name_servers" {
  description = "Name servers of the hosted zone. In staging these are what the parent-zone NS delegation points at; in production they are what the registrar must be set to."
  value       = module.staging_dns.name_servers
}

output "frontend_url" {
  description = "Public origin of the SPA (custom domain, or the CloudFront hostname)"
  value       = local.frontend_url
}

output "api_url" {
  description = "Public API origin (custom domain, or the execute-api endpoint without one). Use frontend_api_base_url for VITE_API_URL."
  value       = local.api_url
}

output "frontend_api_base_url" {
  description = "Value for VITE_API_URL on the matching GitHub Environment: the API host in every environment, staging access gate included"
  value       = local.frontend_api_base_url
}

output "api_invoke_url" {
  description = "HTTP API default execute-api endpoint, which answers 403 while the staging access gate is on"
  value       = module.api.api_endpoint
}

output "api_id" {
  description = "HTTP API id. Value for E2E_API_ID on the matching GitHub Environment, which the post deploy suite reads the live routes with."
  value       = module.api.api_id
}

output "api_access_log_group" {
  description = "Gateway access log group. Value for E2E_ACCESS_LOG_GROUP on the matching GitHub Environment, which the route assertions correlate against."
  value       = module.api.access_log_group_name
}

output "github_actions_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC deployments"
  value       = module.github_actions_role.role_arn
}

output "github_actions_ci_role_arn" {
  description = "IAM role ARN for pull request CI: read only CodeArtifact access and no deploy permissions. Set it as the CI_AWS_ROLE_ARN repository variable, taking the staging workspace's value."
  value       = module.github_actions_ci_role.role_arn
}

output "identity_issuer" {
  description = "The identity issuer, byte identical to the iss claim, to the issuer member of the discovery document, and to the JWT authorizer's configured issuer."
  value       = local.identity_issuer
}

output "identity_audience" {
  description = "The aud claim the identity function stamps on every access token, and the audience the gateway authorizer requires."
  value       = local.identity_audience
}

output "identity_signing_key_arns" {
  description = "The identity signing keys, active signer first. A single key today; a second entry is a rotation in progress."
  value       = local.identity_signing_key_arns
}

output "identity_signing_key_alias" {
  description = "Alias of the active identity signing key. Points at the same key as the first entry of identity_signing_key_arns."
  value       = module.identity.signing_key_alias
}

output "identity_table_names" {
  description = "Logical name to physical name for the identity tables the module creates. The application derives the same strings from DYNAMODB_TABLE_PREFIX, so this is for a reviewer checking an apply."
  value       = module.identity.table_names
}

output "dynamodb_table_names" {
  description = "DynamoDB table names keyed by table suffix"
  value       = module.dynamodb.table_names
}

output "dynamodb_stream_arns" {
  description = "Latest stream ARN keyed by table, for the streamed tables only. The users stream is what the identity module's purge mapping reads."
  value       = { for name in keys(local.dynamodb_stream_view_types) : name => module.dynamodb.stream_arns[name] }
}

output "domain_lambda_function_names" {
  description = "Per-domain Lambda function name keyed by domain. This is the key the deploy workflow builds its function-image map on."
  value       = { for name, fn in module.lambda_domain : name => fn.function_name }
}

output "domain_lambda_function_arns" {
  description = "Per-domain Lambda function ARN keyed by domain, for gateway integrations and alarm function lists."
  value       = { for name, fn in module.lambda_domain : name => fn.function_arn }
}

output "domain_lambda_log_group_names" {
  description = "Per-domain CloudWatch log group name keyed by domain, so a responder tailing one domain does not have to guess the group from the function name."
  value       = { for name, fn in module.lambda_domain : name => fn.log_group_name }
}

output "ecr_repository_urls" {
  description = "Per-domain ECR repository URL keyed by domain. The image build pushes sha- tagged images here and bootstrap_image_tag names one of them."
  value       = module.registry.repository_urls
}

output "staging_access_gate_hosted_ui" {
  description = "Cognito hosted UI base URL of the staging access gate (null when the gate is off)"
  value       = one(module.staging_access_gate[*].hosted_ui_domain)
}

output "staging_access_gate_user_pool_id" {
  description = "Cognito user pool id of the staging access gate (null when the gate is off)"
  value       = one(module.staging_access_gate[*].user_pool_id)
}

output "staging_access_gate_ssm_parameter_name" {
  description = "SSM SecureString holding the x-origin-verify value (null when the gate is off). Value for E2E_GATE_SSM_PARAMETER on the staging GitHub Environment."
  value       = one(module.staging_access_gate[*].origin_verify_ssm_parameter_name)
}

output "e2e_gate_signing_key_ssm_parameter_name" {
  description = "SSM SecureString holding the RSA private key the staging gate signs CloudFront cookies with (null when the gate is off). Value for E2E_GATE_SIGNING_KEY_SSM_PARAMETER on the staging GitHub Environment."
  value       = one(module.staging_access_gate[*].signing_key_ssm_parameter_name)
}

output "e2e_gate_key_pair_id" {
  description = "CloudFront public key id the staging gate trusts (null when the gate is off). Value for E2E_GATE_KEY_PAIR_ID on the staging GitHub Environment."
  value       = one(module.staging_access_gate[*].signing_key_pair_id)
}

output "e2e_gate_cookie_domain" {
  description = "Domain the staging gate scopes its signed session cookies to (null when the gate is off). Value for E2E_GATE_COOKIE_DOMAIN on the staging GitHub Environment."
  value       = one(module.staging_access_gate[*].cookie_domain)
}

output "app_secret_arn" {
  description = "ARN of the one JSON app secret every domain function that reads a secret resolves through APP_SECRETS_ARN"
  value       = module.app_secrets.arns["app"]
}

output "alarm_topic_arn" {
  description = "SNS topic the production alarms publish to. Staging creates the topic but no alarms, per the cost-lean decision."
  value       = module.alarms.sns_topic_arn
}
