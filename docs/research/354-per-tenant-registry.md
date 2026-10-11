# Per-tenant container image registries, research for #354

> Status: research. Sources are current product docs, linked in full per claim; anything not
> verifiable from a fetched page is marked (unverified). Covers how each product names/isolates a
> tenant namespace, mints scoped credentials, and surfaces retention, quotas and deletion. Excludes
> the BountyDesk multi-tenancy model (#326), a prerequisite.

## 1. How current products isolate tenants

All six isolate by a namespace that encodes ownership. The variation is whether credentials are
account-scoped or namespace-scoped, and whether quota is a tenant boundary.

### GHCR (GitHub Container Registry)

A package lives at `ghcr.io/<owner>/<package>`, where `<owner>` is the GitHub org/user. Isolation is
GitHub ownership: a PAT or `GITHUB_TOKEN` is account-scoped (with `read:packages`/`write:packages`/
`delete:packages`), and authorization is enforced server-side
(https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
No per-tenant quota; storage quota is per-repository, retention is manual or via REST API. Delete uses
v2 DELETE by digest, plus a GHCR REST endpoint (`DELETE .../packages/container/{package}/versions/{id}`,
https://docs.github.com/en/rest/packages/packages?apiVersion=2022-11-28). The path `deleteGhcrImage`
(lib/build-onboarding/registry.ts:270) already calls. Fit: the tenant boundary is a GitHub account;
namespace/credential are not per-tenant secrets today.

### AWS ECR (private)

A registry is owned 1:1 by an AWS account; repositories (`<account>.dkr.ecr.<region>.amazonaws.com/<repo>:tag`)
are the isolation unit. Credentials are IAM principals (`aws ecr get-login-password`); authorization is
a per-repository policy scoping `ecr:BatchGetImage`/`PutImage`/`BatchDeleteImage`
(https://docs.aws.amazon.com/AmazonECR/latest/userguide/what-is-ecr.html). Retention is a per-repository
lifecycle policy (https://docs.aws.amazon.com/AmazonECR/latest/userguide/LifecyclePolicies.html); quota
is account-level; delete is `BatchDeleteImage` by digest
(https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_BatchDeleteImage.html).
[unverified: per-account registries beyond the account-owned one.] For BountyDesk: a tenant maps to an
AWS account, since IAM-principal granularity, not namespace, scopes the credential.

### Google Artifact Registry

A repository (`us-docker.pkg.dev/<project>/<repo>/<image>`) is the namespace; IAM binds a principal at
the project or repository level (https://docs.cloud.google.com/artifact-registry/docs/repositories).
Credentials are a service-account JSON key (`_json_key`/`oauth2access`) or workload identity; roles
`roles/artifact.reader`/`writer`/`admin` bind them. Retention is a repository cleanup policy
(documented inline on that page, delete by tag prefix/age); storage quota is project-level; delete is
v2 DELETE by digest. Fit: a tenant maps to a project/repo plus its own service-account JSON, a file
rather than an env token, which is a different shape than BountyDesk's current `REGISTRY_*` env.
[unverified: exact default TTL of a service-account key if rotated.]

### Azure ACR

The registry is the namespace; repositories (`/<repo>:<tag>`) isolate images. Credentials are the admin
user (disabled by default), a Microsoft Entra service principal, a **managed identity**, or
**token-based repository permissions**, a scoped token mapped to repositories with actions
`AcrPush`/`AcrPull`/`AcrDelete`
(https://learn.microsoft.com/en-us/azure/container-registry/container-registry-authentication). That
scoped token is the per-tenant primitive. No native per-tenant TTL; registry-level soft-delete
(https://learn.microsoft.com/en-us/azure/container-registry/container-registry-overview) is the safety
net; delete is v2 DELETE by digest; the scoped token can carry `AcrDelete`. Fit: a single registry with
one scoped token per tenant, scoped to `bountydesk-<tenant>/<slug>`, is the cleanest match here.
[unverified: exact TTL of an ACR scoped token, the docs note ~3 hours for service principals.]

### Harbor

A **project** owns its repositories; private projects use RBAC, and **robot accounts** are scoped
tokens named `<prefix><project>+<account_name>` (default prefix `robot$`, so
`robot$<project>+<name>`; legacy names omit the project
(https://raw.githubusercontent.com/goharbor/website/main/docs/working-with-projects/project-configuration/create-robot-accounts.md)).
Retention is a per-project retention policy (delete/keep by tag prefix, age, untagged)
(https://raw.githubusercontent.com/goharbor/website/main/docs/working-with-projects/working-with-images/create-tag-retention-rules.md);
quota is **per-project storage** (https://raw.githubusercontent.com/goharbor/website/main/docs/administration/configure-project-quotas/_index.md)
, the only tenant-level quota in this set. Replication is project-level with delete propagation, and
delete is v2 DELETE by digest (https://distribution.github.io/distribution/spec/api/). Fit:
purpose-built:
project == tenant, with project-scoped quota, retention and scoped delete.

### Build platforms' credential handoff

Depot, Namespace and Railway do not host tenant isolation; they distribute per-build/per-org
credentials to builders, which is the model BountyDesk should follow.

- Depot: each org gets its own registry subdomain `{orgId}.registry.depot.dev`, and the builder logs
  in with an access token whose documented scopes are user, project, organization, trust relationship
  and pull tokens, presented to `docker login` as username `x-token`
  (https://depot.dev/docs/registry/quickstart). Not stored long-term. Image ref
  `{orgId}.registry.depot.dev/<repo>:<tag>`.
- Namespace: each workload embeds short-lived creds granting access to `nscr.io/<workspace-id>/...`,
  with the namespace being the workspace id and creds rotating with the workload
  (https://namespace.so/docs/solutions/docker-builders/registry.md).
- Railway: per-service Registry Credentials in service Settings; GHCR gets a simplified `read:packages`
  PAT flow; others take Username/Password, including Quay robot accounts (`namespace+robotname`), AWS
  `get-login-password`, and GCP service-account JSON (`docs.railway.com/builds/private-registries.md`).
  Credentials live in the service env, injected at deploy time.

The shared pattern: a per-tenant registry namespace plus a per-tenant scoped credential, handed to
the builder via `docker login` and dropped before the step completes, never as long-lived config.

## 2. Comparison table

| Product | Tenant == | Isolation | Scoped credential | Retention | Quota | Delete |
|---|---|---|---|---|---|---|
| GHCR | GitHub org/user | package visibility + API authz | PAT / `GITHUB_TOKEN`, account-scoped | none (manual/API) | per-repo storage | REST version id / v2 digest |
| AWS ECR | AWS account | per-repository IAM/policy | IAM principal + repo policy | lifecycle /repo | account storage | `BatchDeleteImage` by digest |
| GCP Artifact Registry | GCP project (or repo in it) | per-repository IAM | service-account JSON key | cleanup policy /repo | project storage | v2 DELETE by digest |
| Azure ACR | registry | per-repository scoped token | scoped token (`AcrPush`/`Pull`/`Delete`) | ACR Tasks cleanup | registry soft-delete | v2 DELETE by digest |
| Harbor | project | project RBAC + robot identity | **robot account** (`<prefix><project>+<name>`) | retention /project | **per-project quota** | v2 DELETE by digest |
| Depot | organization | registry subdomain | short-lived access token (x-token) | none native | none | v2 / `docker rmi` |
| Namespace | workspace | `nscr.io/<workspace-id>/` | short-lived embedded creds | none | none | v2 / `docker rmi` |
| Railway | service/env | service Settings registry creds | Username/Password per service | provider-native | provider-native | provider-native |

Honest line: Harbor is the only product with a tenant-level quota boundary; everywhere else quota is
one level up (account/project/registry).

## 3. How it fits BountyDesk's existing code

BountyDesk already abstracted push/pull/delete, so this is a new `RegistryHandoff` impl plus a
new secret source, not a rewrite.

The seam is `RegistryHandoff` (lib/build-onboarding/registry.ts): `push`, `deleteImage`, `listTags`
and the `namespace` getter. `createRegistry`/`resolveRegistry` (registry.ts:63/76) build the GHCR
default from `REGISTRY_*`/`GHCR_*` env, reading every token via `requireSecret` in lib/env.ts. The
driver calls it once at lib/build-onboarding/daytona-build-driver.ts:177 and threads it through
`buildMesh`/`pushAndDigest` (daytona-build-driver.ts:520/585, `reclaimOriginImage` :603). The orphan
sweep uses it from lib/build-onboarding/worker.ts:688, keyed on the `bountydesk-` tag prefix at
worker.ts:715. Image-name allow-listing is lib/build-onboarding/image-registries.ts
(`PREBUILT_IMAGE_REGISTRIES`); `IMAGE_NAME_RE` in lib/targets/manifest.ts accepts any registry host.
`targetProfile.imageName` (lib/db/schema.ts:277) stores the registry-qualified image ref, so the
per-tenant namespace is already part of the bound target identity; the drift check in
lib/build-onboarding/source-identity.ts pins by digest, which is registry-agnostic.

To land per-tenant registries:

- Add a tenant-keyed `RegistryConfig` to the secret store (encrypted-secrets phase of #326) and a
  `resolveTenantRegistry(tenantId)` that builds a `RegistryHandoff` per tenant. The credential window
  in `push` (registry.ts:102) introduces the token only for `docker login`/`push`, logs out after, and
  is wire-protocol compatible; `deleteV2Image`/`listV2Tags` (registry.ts:217/192) already use Basic-auth
  against the configured host, working unchanged for Harbor and ACR tokens.
- The driver (daytona-build-driver.ts:177) and sweep caller (worker.ts:688) take the `tenantId`
  carried on the onboarding row and pass it to `resolveTenantRegistry`.
- The allow-list (`BUILD_EGRESS_ALLOWLIST`, lib/build-onboarding/egress-profiles.ts, includes
  `ghcr.io` today) gains the tenant's registry host from its secret record, not from customer input.
  [unverified: the exact egress-profile shape after the per-ecosystem tightening in
  docs/onboarding-follow-ups.md.]
- The reclaim window (`reclaimOriginImage` at daytona-build-driver.ts:603) and orphan sweep
  (worker.ts:715, keyed on `bountydesk-`) become tenant-aware so one tenant's tag prefix cannot be
  reclaimed by another's sweep.

What is NOT built, per docs/onboarding-follow-ups.md and #354: "a self-hosted private registry at
multi-tenant scale" and "credentials come from the per-tenant secret store". Both land in the
encrypted-secrets phase of #326. The `RegistryHandoff` seam itself is done.

## 4. Risks and open questions

- Credential lifetime. Depot/Namespace rotate tokens with the workload; GHCR PATs, ACR tokens, ECR
  `get-login-password`, and GCP service-account JSON are longer-lived. A per-tenant self-hosted
  registry credential must not be a long-lived store secret. The build already drops the token after
  the push window, but a tenant credential living in the store for its lifetime is a standing secret
  needing a rotation/refresh path.
- Namespace collision. Per-tenant hosts (`tenant-<id>.harbor.example.com`) or repo-scoped tokens need
  the slug to derive from a server-owned tenant id, not customer input. `registry.ts` `namespace` is
  currently a single trimmed env string (createRegistry at registry.ts:63 re-validates it with
  `HOST_RE`/`USER_RE`); per-tenant it must be a tenant-scoped value from the secret store.
- Delete granularity. `deleteV2Image` (registry.ts:217) implements v2 DELETE by digest on the
  configured host with Basic-auth, covering Harbor, ACR tokens, and self-hosted distros, while GHCR
  stays on its REST path. The orphan sweep must key off the tenant namespace, not the global one.
- Quota and retention ownership. Only Harbor exposes a per-project quota boundary. For ECR/Artifact
  Registry/AWS-registry models, tenant storage quota is the account/project, so BountyDesk cannot
  enforce a per-tenant byte cap without its own accounting table; no platform-native retention is
  exposed by `RegistryHandoff` today.
- Scope. This issue stops at handing the tenant's registry to the build sandbox; the multi-tenant
  RBAC, `tenant_id` enforcement, and encrypted secret store are #326 and out of scope here. Per
  AGENTS.md, do not build the registry piece before tenancy is real.
