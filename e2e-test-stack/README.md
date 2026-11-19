# e2e-test-stack suite

Playwright checks run against one remote test server from the e2e-test-stack control plane, one job per server.

| Workflow                                                                                                    | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | AWS role |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [`e2e-test-stack-run.yml`](../.github/workflows/e2e-test-stack-run.yml)                                     | The E2E workflow: push to `master` and dispatch with every create choice. Calls create, runs the suite per server in a matrix, calls destroy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | No       |
| [`e2e-test-stack-run-services.yml`](../.github/workflows/e2e-test-stack-run-services.yml)                   | The same, with MinIO, Elasticsearch, Keycloak and OpenLDAP: calls `e2e-test-stack-run.yml` on push to `master` and dispatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | No       |
| [`e2e-test-stack-mobile.yml`](../.github/workflows/e2e-test-stack-mobile.yml)                               | By hand only, per platform (`platform`: `detox-ios` or `detox-android`): mattermost-mobile's Detox suite on stack servers, from the matching `ios-build-simulator-*` or `android-build-files-*` artifact of a mobile E2E run (its link) and that build's commit. With `upload_to_tsio`, the results go to Test System IO under this repository as `mobile-e2e-test-stack-<platform>`. Mobile's splitter makes the shards; one batch serves the run, a server per shard plus the shared second and third for the multi-server specs. Destroyed when every shard passes or the run is cancelled; kept, with its logs collected, for a re-run of failed shards, which must start within the batch's 4-hour TTL | No       |
| [`e2e-test-stack-mobile-ios-shard.yml`](../.github/workflows/e2e-test-stack-mobile-ios-shard.yml)           | Reusable, one per iOS shard: opens and provisions the shard's own server, then runs its specs with mobile's iOS test steps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | No       |
| [`e2e-test-stack-mobile-android-shard.yml`](../.github/workflows/e2e-test-stack-mobile-android-shard.yml)   | Reusable, one per Android shard: opens and provisions the shard's own server, then runs its specs with mobile's Android test steps on an emulator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | No       |
| [`e2e-test-stack-mobile-provision`](../.github/actions/e2e-test-stack-mobile-provision/action.yml) (action) | A copy of mobile's `provision-e2e-servers`, adapted to the stack: it drops the baseline's `AllowedUntrustedInternalConnections` entry (the stack pins that setting) and installs only the demo plugin, enabling the prepackaged Agents and Calls rather than downloading them                                                                                                                                                                                                                                                                                                                                                                                                                               | No       |
| [`e2e-test-stack-create.yml`](../.github/workflows/e2e-test-stack-create.yml)                               | Reusable: create, fetch to check every server is ready, upload the sealed create response                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Yes      |
| [`e2e-test-stack-destroy.yml`](../.github/workflows/e2e-test-stack-destroy.yml)                             | Reusable, and run by hand for a batch a run kept: every server's logs, destroy, the router's 404, destroy again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Yes      |

Each test job opens its own server's credentials from the uploaded create response with the action's `open`, which
needs the private key but no AWS role. Masked values do not pass between jobs, and the CI role trusts only the two
called files. Mobile and desktop follow the same shape: their existing E2E workflow calls their own two files around
its test matrix.

| File                     | What it checks                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/api.spec.ts`      | Ping, the admin's role, the licence, membership, a post's create, edit, reaction and delete, a password reset email in Inbucket, and Inbucket refusing a request without the mail token                                   |
| `tests/services.spec.ts` | Each requested service: MinIO stores and serves an upload; the server's Elasticsearch and LDAP connection tests pass; Keycloak serves the SAML realm the server is pointed at. Skipped when the service was not requested |
| `tests/ui.spec.ts`       | Login refusing a wrong password, and login opening the channel                                                                                                                                                            |
| `scripts/probe-gone.sh`  | Run by the workflows after destroy: each site, its `mail-` host, and its `sso-` host when Keycloak was requested, must get the router's 404 for a test server that no longer exists, each within 3 minutes                |

Each run creates its own team, channel and member, named for the run. Retries are off. No trace or video is kept, and
CI writes no HTML report and uploads only failed tests' screenshots: the others record the passwords and tokens.

## Environment

| Variable                           | From the `open` step                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `SITE_URL`                         | `site-url`                                                                           |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | `admin-username`, `admin-password`                                                   |
| `MAIL_TOKEN`                       | `mail-token`: Inbucket's HTTP Basic password, user `inbucket`, at `mail-<site host>` |
| `EXPECT_LICENSED`                  | `true` when the batch was created with a licence                                     |
| `EXPECT_SERVICES`                  | The batch's `services`, comma-separated                                              |
| `SERVICE_FACTS`                    | The server's `facts` from `open`'s `instances` output, as JSON                       |

## Server logs

Each run uploads every server's full log as `e2e-test-stack-logs-<index>`, kept 14 days: the Mattermost server and
each service, every one headed `===== <container> =====`.

A destroy run by hand for a batch a run kept uploads the logs of its servers that are still up; a batch already gone
has none.

```sh
gh run download <run id> -R mattermost/test-public-project -n e2e-test-stack-logs-0 -D logs
```

## Development

Node 26. `npm install` also installs a pre-commit hook that runs `fmt:check` (Prettier), `lint` (ESLint), `tsc` and
[yamllint](https://github.com/adrienverge/yamllint) on the e2e-test-stack workflows (rules in `.yamllint`; yamllint must be installed);
[`e2e-test-stack-check.yml`](../.github/workflows/e2e-test-stack-check.yml) runs the same on pull requests.

```sh
npm install
npx playwright install chromium
SITE_URL=... ADMIN_USERNAME=... ADMIN_PASSWORD=... MAIL_TOKEN=... EXPECT_LICENSED=true npm test
```
