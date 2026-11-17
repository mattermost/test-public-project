import { call } from './support/api';
import { expectLicensed, mailToken, mailURL } from './support/env';
import { expect, test, type Post } from './support/fixtures';

test('the server answers a ping without a session', async ({ request }) => {
  const response = await request.get('/api/v4/system/ping');
  expect(response.status()).toBe(200);
  expect(((await response.json()) as { status: string }).status).toBe('OK');
});

test('the admin is a system admin', async ({ request, world }) => {
  const me = await call<{ roles: string }>(request, 'GET', '/api/v4/users/me', world.admin);
  expect(me.roles.split(' ')).toContain('system_admin');
});

test('the licence matches the request', async ({ request }) => {
  const response = await request.get('/api/v4/license/client?format=old');
  expect(response.status()).toBe(200);
  expect(((await response.json()) as { IsLicensed: string }).IsLicensed).toBe(expectLicensed ? 'true' : 'false');
});

test('the member belongs to the team and the channel', async ({ request, world }) => {
  const teams = await call<{ id: string }[]>(request, 'GET', '/api/v4/users/me/teams', world.user.auth);
  expect(teams.map((team) => team.id)).toContain(world.team.id);
  const member = await call<{ user_id: string }>(
    request,
    'GET',
    `/api/v4/channels/${world.channel.id}/members/me`,
    world.user.auth,
  );
  expect(member.user_id).toBe(world.user.id);
});

test.describe('a post', () => {
  // Each step acts on the post the first one creates.
  test.describe.configure({ mode: 'serial' });
  let post: Post;

  test('the member posts and the post reads back', async ({ request, world }) => {
    const message = `API post ${Date.now()}`;
    post = await call<Post>(request, 'POST', '/api/v4/posts', world.user.auth, {
      channel_id: world.channel.id,
      message,
    });
    const list = await call<{ order: string[]; posts: Record<string, Post> }>(
      request,
      'GET',
      `/api/v4/channels/${world.channel.id}/posts`,
      world.user.auth,
    );
    expect(list.order).toContain(post.id);
    expect(list.posts[post.id].message).toBe(message);
  });

  test('the member edits the post', async ({ request, world }) => {
    const edited = await call<Post>(request, 'PUT', `/api/v4/posts/${post.id}/patch`, world.user.auth, {
      message: `${post.message} (edited)`,
    });
    expect(edited.message).toBe(`${post.message} (edited)`);
    expect(edited.edit_at).toBeGreaterThan(0);
  });

  test('the member reacts to the post', async ({ request, world }) => {
    await call(
      request,
      'POST',
      '/api/v4/reactions',
      world.user.auth,
      { user_id: world.user.id, post_id: post.id, emoji_name: 'white_check_mark' },
      200,
    );
    const reactions = await call<{ emoji_name: string; user_id: string }[]>(
      request,
      'GET',
      `/api/v4/posts/${post.id}/reactions`,
      world.user.auth,
    );
    expect(reactions).toContainEqual(
      expect.objectContaining({ emoji_name: 'white_check_mark', user_id: world.user.id }),
    );
  });

  test('the member deletes the post', async ({ request, world }) => {
    await call(request, 'DELETE', `/api/v4/posts/${post.id}`, world.user.auth);
    const response = await request.get(`/api/v4/posts/${post.id}`, { headers: world.user.auth });
    expect(response.status()).toBe(404);
  });
});

test.describe('mail', () => {
  const basic = (password: string) => ({
    Authorization: `Basic ${Buffer.from(`inbucket:${password}`).toString('base64')}`,
  });

  test('a password reset email reaches Inbucket', async ({ request, world }) => {
    // The stack points the server at Inbucket; sending is left to the suite.
    await call(request, 'PUT', '/api/v4/config/patch', world.admin, {
      EmailSettings: {
        SendEmailNotifications: true,
        FeedbackEmail: 'test@example.com',
        ReplyToAddress: 'test@example.com',
      },
    });
    await call(request, 'POST', '/api/v4/users/password/reset/send', {}, { email: world.user.email }, 200);

    const mailbox = `${mailURL}/api/v1/mailbox/${world.user.username}`;
    await expect
      .poll(
        async () => {
          const response = await request.get(mailbox, { headers: basic(mailToken) });
          // A refusal shows in the failure message instead of as a timeout.
          if (response.status() !== 200) return [`HTTP ${response.status()}`];
          return ((await response.json()) as { subject: string }[]).map((message) => message.subject);
        },
        { timeout: 30_000 },
      )
      .toContainEqual(expect.stringMatching(/reset/i));
  });

  test('Inbucket refuses a request without the mail token', async ({ request }) => {
    const mailbox = `${mailURL}/api/v1/mailbox/nobody`;
    expect((await request.get(mailbox)).status()).toBe(401);
    expect((await request.get(mailbox, { headers: basic('not-the-token') })).status()).toBe(401);
  });
});
