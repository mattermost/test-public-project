# e2e-test-stack suite

Playwright checks run against one remote test server from the e2e-test-stack control plane, by
[`.github/workflows/e2e-test-stack-create.yml`](../.github/workflows/e2e-test-stack-create.yml): one job per server,
each with the credentials it fetched for its own server.

| File                    | What it checks                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/api.spec.ts`     | Ping, the admin's role, the licence, membership, a post's create, edit, reaction and delete, a password reset email in Inbucket, and Inbucket refusing a request without the mail token |
| `tests/ui.spec.ts`      | Login refusing a wrong password, login, posting and replying in a thread, and a post made through the API appearing without a reload                                                    |
| `scripts/probe-gone.sh` | Run by the workflows after destroy: each site and its `mail-` host must get the router's 404 for a test server that no longer exists, within 3 minutes                                  |

Each run creates its own team, channel and member, named for the run. Retries are off. No trace or video is kept, and
CI writes no HTML report and uploads only failed tests' screenshots: the others record the passwords and tokens.

## Environment

| Variable                           | From the fetch step                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `SITE_URL`                         | `site_url`                                                                           |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | `admin_username`, `admin_password`                                                   |
| `MAIL_TOKEN`                       | `mail_token`: Inbucket's HTTP Basic password, user `inbucket`, at `mail-<site host>` |
| `EXPECT_LICENSED`                  | `true` when the batch was created with a licence                                     |

## Development

Node 26. `npm install` also installs a pre-commit hook that runs `fmt:check` (Prettier), `lint` (ESLint), `tsc` and
[yamllint](https://github.com/adrienverge/yamllint) on the e2e-test-stack workflows (rules in `.yamllint`; yamllint must be installed);
[`e2e-test-stack-check.yml`](../.github/workflows/e2e-test-stack-check.yml) runs the same on pull requests.

```sh
npm install
npx playwright install chromium
SITE_URL=... ADMIN_USERNAME=... ADMIN_PASSWORD=... MAIL_TOKEN=... EXPECT_LICENSED=true npm test
```
