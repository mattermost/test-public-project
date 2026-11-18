# e2e-test-stack suite

Playwright checks run against one remote test server from the e2e-test-stack control plane, one job per server.

| Workflow                                                                        | Role                                                                                                                                         | AWS role |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [`e2e-test-stack-run.yml`](../.github/workflows/e2e-test-stack-run.yml)         | The E2E workflow: push to `master` and dispatch with every create choice. Calls create, runs the suite per server in a matrix, calls destroy | No       |
| [`e2e-test-stack-create.yml`](../.github/workflows/e2e-test-stack-create.yml)   | Reusable: create, fetch to check every server is ready, upload the sealed create response                                                    | Yes      |
| [`e2e-test-stack-destroy.yml`](../.github/workflows/e2e-test-stack-destroy.yml) | Reusable, and run by hand for a batch a run kept: every server's logs, destroy, the router's 404, destroy again                              | Yes      |

Each test job opens its own server's credentials from the uploaded create response with the action's `open`, which
needs the private key but no AWS role. Masked values do not pass between jobs, and the CI role trusts only the two
called files. Mobile and desktop follow the same shape: their existing E2E workflow calls their own two files around
its test matrix.

| File                    | What it checks                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/api.spec.ts`     | Ping, the admin's role, the licence, membership, a post's create, edit, reaction and delete, a password reset email in Inbucket, and Inbucket refusing a request without the mail token |
| `tests/ui.spec.ts`      | Login refusing a wrong password, login, posting and replying in a thread, and a post made through the API appearing without a reload                                                    |
| `scripts/probe-gone.sh` | Run by the workflows after destroy: each site and its `mail-` host must get the router's 404 for a test server that no longer exists, each within 3 minutes                             |

Each run creates its own team, channel and member, named for the run. Retries are off. No trace or video is kept, and
CI writes no HTML report and uploads only failed tests' screenshots: the others record the passwords and tokens.

## Environment

| Variable                           | From the `open` step                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `SITE_URL`                         | `site-url`                                                                           |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | `admin-username`, `admin-password`                                                   |
| `MAIL_TOKEN`                       | `mail-token`: Inbucket's HTTP Basic password, user `inbucket`, at `mail-<site host>` |
| `EXPECT_LICENSED`                  | `true` when the batch was created with a licence                                     |

## Server logs

Each run uploads every server's full log as `e2e-test-stack-logs-<index>`, kept 14 days: the Mattermost server and
each service, every one headed `===== <container> =====`.

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
