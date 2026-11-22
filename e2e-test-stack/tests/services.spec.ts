import { call } from './support/api';
import { expectLicensed, expectServices, serviceFacts } from './support/env';
import { expect, test } from './support/fixtures';

// One check per optional service, each skipped unless the batch was created with it. Nothing here changes the
// server's configuration, apart from the channel and slash command the webhook check adds: the Elasticsearch and LDAP
// checks send candidate settings to the server's own tests.

type Config = {
  FileSettings: { DriverName: string };
  ElasticsearchSettings: Record<string, unknown> & { EnableIndexing: boolean };
  LdapSettings: Record<string, unknown>;
  SamlSettings: { IdpDescriptorURL: string };
};

const config = (request: Parameters<typeof call>[0], admin: Record<string, string>) =>
  call<Config>(request, 'GET', '/api/v4/config', admin);

test('MinIO stores and serves a file the member uploads', async ({ request, world }) => {
  test.skip(!expectServices.has('minio'), 'minio was not requested');
  expect((await config(request, world.admin)).FileSettings.DriverName).toBe('amazons3');

  const content = `stored ${Date.now()}`;
  const upload = await request.post(`/api/v4/files?channel_id=${world.channel.id}`, {
    headers: world.user.auth,
    multipart: { files: { name: 'check.txt', mimeType: 'text/plain', buffer: Buffer.from(content) } },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const [info] = ((await upload.json()) as { file_infos: { id: string }[] }).file_infos;
  const file = await request.get(`/api/v4/files/${info.id}`, { headers: world.user.auth });
  expect(file.status()).toBe(200);
  expect(await file.text()).toBe(content);
});

test('the server reaches Elasticsearch', async ({ request, world }) => {
  test.skip(!expectServices.has('elasticsearch'), 'elasticsearch was not requested');
  test.skip(!expectLicensed, 'Elasticsearch is a licensed feature');
  const current = await config(request, world.admin);
  // The test refuses settings with indexing off; these are sent to the test only, not saved.
  await call(
    request,
    'POST',
    '/api/v4/elasticsearch/test',
    world.admin,
    {
      ...current,
      ElasticsearchSettings: { ...current.ElasticsearchSettings, EnableIndexing: true },
    },
    200,
  );
});

test('the server binds to OpenLDAP', async ({ request, world }) => {
  test.skip(!expectServices.has('openldap'), 'openldap was not requested');
  test.skip(!expectLicensed, 'LDAP is a licensed feature');
  const current = await config(request, world.admin);
  await call(
    request,
    'POST',
    '/api/v4/ldap/test_connection',
    world.admin,
    {
      ...current.LdapSettings,
      BindUsername: serviceFacts['openldap.bind_dn'],
      BindPassword: serviceFacts['openldap.bind_password'],
      BaseDN: serviceFacts['openldap.root_dn'],
    },
    200,
  );
});

test('Keycloak serves the SAML realm the server is pointed at', async ({ request, world }) => {
  test.skip(!expectServices.has('keycloak'), 'keycloak was not requested');
  const descriptor = (await config(request, world.admin)).SamlSettings.IdpDescriptorURL;
  expect(descriptor).toBe(`${serviceFacts['keycloak.public_url']}${serviceFacts['keycloak.descriptor_path']}`);
  const response = await request.get(descriptor);
  expect(response.status()).toBe(200);
  expect(((await response.json()) as { realm: string }).realm).toBe(serviceFacts['keycloak.realm']);
});

test('the server calls the webhook sidecar inside the instance', async ({ request, world }) => {
  test.skip(!expectServices.has('webhook'), 'webhook was not requested');
  // The address mobile's workflows set as WEBHOOK_BASE_URL.
  const base = serviceFacts['webhook.url'];
  expect(base).toBe('http://webhook:3000');

  // A channel of its own, so the only posts in it are the responses to this command.
  const channel = await call<{ id: string }>(request, 'POST', '/api/v4/channels', world.admin, {
    team_id: world.team.id,
    name: `webhook-${Date.now()}`,
    display_name: 'Webhook sidecar check',
    type: 'O',
  });
  await call(request, 'POST', `/api/v4/channels/${channel.id}/members`, world.admin, { user_id: world.user.id });

  // A slash command the sidecar answers with two in-channel responses, which the server posts.
  const trigger = `webhook${Date.now()}`;
  await call(request, 'POST', '/api/v4/commands', world.admin, {
    team_id: world.team.id,
    trigger,
    method: 'P',
    url: `${base}/send_message_to_channel?channel_id=${channel.id}`,
    display_name: 'Webhook sidecar check',
  });
  await call(
    request,
    'POST',
    '/api/v4/commands/execute',
    world.user.auth,
    { channel_id: channel.id, team_id: world.team.id, command: `/${trigger}` },
    200,
  );

  await expect
    .poll(async () => {
      const { order, posts } = await call<{
        order: string[];
        posts: Record<string, { message: string; type: string }>;
      }>(request, 'GET', `/api/v4/channels/${channel.id}/posts`, world.user.auth);
      // Joining the channel adds system posts; the responses are regular ones.
      return order
        .filter((id) => !posts[id].type.startsWith('system_'))
        .map((id) => posts[id].message)
        .sort();
    })
    .toEqual(['Extra response 2', 'Hello World']);
});
