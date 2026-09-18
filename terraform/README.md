# Terraform: Standupless AWS Infrastructure

One root module, applied by two HCP Terraform workspaces in the `WebbPulse` organization:

| Workspace | VCS branch | `environment` | `staging_profile` |
| --- | --- | --- | --- |
| `Standupless` | `main` | `production` | n/a |
| `Standupless-staging` | `staging` | `staging` | `full` or `reduced` |

The `cloud` block in `versions.tf` names `Standupless`; the staging workspace overrides it with its
own workspace configuration. State lives in HCP Terraform and AWS credentials come from HCP dynamic
provider credentials, so the local checkout needs none.

**Manual apply is the real gate on production.** A merge to `main` queues a run; someone confirms it.

## What this builds

Single region, `us-west-2`. Route 53 and ACM for the served domain, CloudFront and S3 for the SPA,
an HTTP API in front of the per-domain Lambda container images, DynamoDB tables, SES, Secrets
Manager, CloudWatch alarms and X-Ray Transaction Search. The CloudFront certificate is issued in
`us-east-1` through the `aws.us_east_1` alias; the API certificate is regional. There is no VPC and
no NAT Gateway.

Almost everything comes from `app.terraform.io/WebbPulse/platform-modules/aws` submodules, pinned
`~> 2.22` except `http-api` and `staging-access-gate`, which need the plan time known counts
released in 2.25 and are pinned `~> 2.25`: `app-baseline`, `staging-dns`, `acm-certificate`,
`spa-frontend`, `http-api`, `lambda-function`, `ecr-repository`, `dynamodb-tables`, `identity`,
`app-secrets`, `api-alarms`, `staging-access-gate` and `github-actions-role`. Hand written is what a
single-provider module cannot own: the SES records and identity, the CloudFront Function, and the
Transaction Search plumbing.

## Domains

`lambda_domains.tf` declares one entry per backend domain in `local.lambda_domains_declared`, and
`ecr.tf` lists the same names in `local.lambda_domain_names`. Today that is `identity`,
`workspaces` and `projects`. Adding a domain is one entry in each of those, one path prefix in
`local.lambda_domain_path_prefixes` and its name in `local.routed_lambda_domains_declared`.

`var.bootstrap_image_tag` gates every domain function through `local.domain_functions_enabled`: the
empty string resolves `local.lambda_domains` to empty, so a fresh account applies once and builds
the registry, the tables, the identity tables and signing key, the gateway and the DNS with no
function and no route. The same boolean holds back everything that needs the identity function to
exist: the identity module's `attach_role_policies` and `users_stream_enabled`, and both
`identity_jwt_mode` enforcement paths.

## Bootstrapping a fresh account

Three runs. Nothing here is optional and the order matters, because each run creates what the next
one reads.

| Run | Variables | What it creates |
| --- | --- | --- |
| 1 | `bootstrap_image_tag = ""`, `identity_jwt_mode = "gate"`, `adopt_spans_log_group = false` | Everything except the domain functions: registry, tables, identity tables and signing key, secrets, gateway, gate, CloudFront, DNS, SES |
| 2 | `bootstrap_image_tag = "sha-<head sha>"`, others unchanged | The domain functions, their routes and runtime policies, the identity role policies and the users stream purge mapping |
| 3 | `adopt_spans_log_group = true`, others unchanged | Imports the `aws/spans` log group to hold 7 day retention |

Between run 1 and run 2, push the images: the container image build has to have pushed a `sha-`
tagged image to every per-domain repository the registry created in run 1, and
`bootstrap_image_tag` must name one that still exists. Between run 2 and run 3, generate one span by
calling the API, because X-Ray creates `aws/spans` on the first export and an import block whose
target does not exist is a plan time error.

`identity_jwt_mode` stays `"gate"` throughout. The gate enforces tokens in its own Lambda, which
reads JWKS at request time, so it never needs the issuer live at apply time. Only
`identity_jwt_mode = "native"` does, and flipping to it is a fourth run that must wait until the
identity function is deployed and serving both `.well-known` routes at the API host. Run 1 holds
both modes back anyway, since `local.domain_functions_enabled` is false.

## Domains and hostnames

Production serves `standupless.dev` with the API on `api.standupless.dev`. Staging serves
`staging.standupless.dev` with the API on `api.staging.standupless.dev`.

The apex zone is external to the staging account, so `staging-dns` runs in the external-apex shape:
production creates the `standupless.dev` zone with `delegate = false` and the registrar is pointed
at `route53_zone_name_servers` by hand, and staging creates the `staging.standupless.dev` child zone
with `delegate = true`, writing its NS delegation into `parent_route53_zone_id` through the
`aws.parent_dns` alias, which assumes `route53_write_role_arn` in the production account.

## Tables

`dynamodb_tables.json` mirrors `backend/app/common/db/dynamo/tables.py` plus the `rate-limits`
table, which no repository declares because the rate limiter owns it. The identity tables are not
here: the `identity` module provisions them with the key schemas the `webbpulse.identity` package
requires. The `users` table carries a `KEYS_ONLY` stream, which is what the identity module's purge
mapping reads when a user row is deleted.

## Alarms

Three alarms in production, none in staging: HTTP API 5xx, account wide Lambda errors and account
wide Lambda throttles. The SNS topic and its subscriptions exist in both environments.

## HCP workspace variables

| Variable | Notes |
| --- | --- |
| `environment`, `staging_profile` | Pushed from the WebbPulse-Platform repo. |
| `parent_route53_zone_id`, `route53_write_role_arn` | Staging only, pushed from WebbPulse-Platform. A validation requires both once staging has a custom domain. |
| `staging_access_gate`, `staging_access_users` | Staging only, pushed from WebbPulse-Platform. |
| `secret_key` | Sensitive, set by hand. Lands in the `<prefix>/app` JSON as `SECRET_KEY`. |
| `oauth_google_client_secret`, `oauth_github_client_secret` | Sensitive, set by hand. The matching client ids are ordinary variables. |
| `bootstrap_image_tag` | The `sha-<40 hex>` seed tag every image function is created from. Empty is the fresh account state; see the bootstrap sequence above. |
| `adopt_spans_log_group` | Whether to import the reserved `aws/spans` log group. False until a span exists. |
| `identity_jwt_mode`, `domain_jwt_enforced`, `ephemeral_users_enabled` | Gateway enforcement and the e2e user routes. |

## GitHub Environment variables and their outputs

| Variable | Output |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | `github_actions_role_arn` |
| `FRONTEND_S3_BUCKET` | `frontend_bucket` |
| `CLOUDFRONT_DISTRIBUTION_ID` | `cloudfront_distribution_id` |
| `VITE_API_URL` | `frontend_api_base_url` |
| `E2E_API_ID` | `api_id` |
| `E2E_ACCESS_LOG_GROUP` | `api_access_log_group` |

`CI_AWS_ROLE_ARN` is repository-scoped rather than environment-scoped, because a `pull_request` job
cannot read an Environment whose deployment branch policy admits only `main` and `staging`. Take the
staging workspace's `github_actions_ci_role_arn`.

## Gotchas

- **An API Gateway route key cannot end in a slash**, and a path part is either a whole variable or
  a literal. Both plan green and fail the apply with a `BadRequestException`.
- **`bootstrap_image_tag` is a create-time seed that expires out from under you.** The ECR lifecycle
  policy keeps the last three tagged images per repository, so refresh it to a current tag before
  any apply that creates a function. A speculative plan cannot detect a stale tag.
- **`aws/spans` is a reserved log group name.** `CreateLogGroup` rejects names beginning with
  `aws/`, so X-Ray creates it on the first span export and `transaction_search.tf` imports it. An
  import block whose target does not exist is a plan time error, so a brand new account applies with
  `adopt_spans_log_group = false` until a span has been generated.
- **A DynamoDB stream view type cannot be edited once a stream exists.** Changing one mints a new
  stream ARN and silently detaches the identity purge mapping.
- **The identity JWT authorizer fetches the discovery document at create time**, so
  `identity_jwt_mode = "native"` fails the apply until the identity function is deployed and serving
  both `.well-known` routes at the production API host. The `"gate"` mode has no such ordering: the
  gate Lambda reads JWKS per request.
- **A count cannot be derived from a value created by the same apply.** The hosted zone id and the
  HTTP API id are both unknown on a fresh account's first plan, and Terraform refuses such a count
  outright with `Invalid count argument` rather than deferring it. That is why `module "api"` passes
  `dns_record_enabled` and `module "staging_access_gate"` passes `http_api_attached`, both literal
  booleans this root already knows, instead of letting the modules test those ids for null.

## Conventions

- **Naming**: every resource name starts with `local.prefix`, `standupless-<environment>`.
- **Tags**: `Project`, `Environment`, `ManagedBy=terraform`, applied globally via `default_tags`.
- **Secrets**: HCP workspace variable to `var.*` to Secrets Manager, written write-only so no value
  reaches state. No secret values live in outputs or version control.
- **Lambda code is not Terraform's**: every function is a container image and Terraform owns the
  create only.

## Local validation

```bash
terraform fmt -check -recursive terraform/
cd terraform && terraform init -backend=false && terraform validate
```
