import { randomBytes } from 'node:crypto';

import { test as base, request as requestFactory } from '@playwright/test';

import { bearer, call, login, type Headers } from './api';
import { adminPassword, adminUsername, siteURL } from './env';

export type Post = { id: string; message: string; root_id: string; edit_at: number; channel_id: string };

export type World = {
  admin: Headers;
  team: { id: string; name: string };
  channel: { id: string; name: string };
  user: { id: string; username: string; email: string; password: string; auth: Headers };
};

// One team, channel and member per worker, named for this run so nothing depends on how the server was seeded.
export const test = base.extend<object, { world: World }>({
  world: [
    async ({}, use) => {
      const request = await requestFactory.newContext({ baseURL: siteURL });
      const suffix = randomBytes(4).toString('hex');
      const admin = bearer(await login(request, adminUsername, adminPassword));

      const team = await call<{ id: string; name: string }>(request, 'POST', '/api/v4/teams', admin, {
        name: `stack-${suffix}`,
        display_name: `Stack ${suffix}`,
        type: 'O',
      });
      const channel = await call<{ id: string; name: string }>(request, 'POST', '/api/v4/channels', admin, {
        team_id: team.id,
        name: `checks-${suffix}`,
        display_name: `Checks ${suffix}`,
        type: 'O',
      });

      const username = `member-${suffix}`;
      const email = `${username}@example.com`;
      const password = `Pw-${randomBytes(12).toString('base64url')}-9`;
      const user = await call<{ id: string }>(request, 'POST', '/api/v4/users', admin, {
        username,
        email,
        password,
      });
      await call(request, 'POST', `/api/v4/teams/${team.id}/members`, admin, { team_id: team.id, user_id: user.id });
      await call(request, 'POST', `/api/v4/channels/${channel.id}/members`, admin, { user_id: user.id });

      // Marks the member's tours as seen, so no tip covers the page.
      await call(request, 'PUT', `/api/v4/users/${user.id}/preferences`, admin, [
        { user_id: user.id, category: 'tutorial_step', name: user.id, value: '999' },
        { user_id: user.id, category: 'crt_thread_pane_step', name: user.id, value: '999' },
        { user_id: user.id, category: 'onboarding_task_list', name: 'onboarding_task_list_show', value: 'false' },
      ]);

      const auth = bearer(await login(request, username, password));
      await use({ admin, team, channel, user: { id: user.id, username, email, password, auth } });
      await request.dispose();
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';
