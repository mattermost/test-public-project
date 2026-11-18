import type { Page } from '@playwright/test';

import { call } from './support/api';
import { expect, test, type Post, type World } from './support/fixtures';

const channelPath = (world: World) => `/${world.team.name}/channels/${world.channel.name}`;

// Logs in through the login page, as a person does: the web app keeps the session it is given there.
async function logIn(page: Page, world: World): Promise<void> {
  await page.goto('/login');
  await page.locator('#input_loginId').fill(world.user.username);
  await page.locator('#input_password-input').fill(world.user.password);
  await page.locator('#saveSetting').click();
  // Signed in: the web app moves its only team member into that team.
  await expect(page).toHaveURL(new RegExp(`/${world.team.name}/channels/`));
}

async function findPost(request: Parameters<typeof call>[0], world: World, message: string): Promise<Post> {
  let found: Post | undefined;
  await expect
    .poll(async () => {
      const list = await call<{ posts: Record<string, Post> }>(
        request,
        'GET',
        `/api/v4/channels/${world.channel.id}/posts`,
        world.user.auth,
      );
      found = Object.values(list.posts).find((post) => post.message === message);
      return found?.id;
    })
    .toBeTruthy();
  return found!;
}

test('the login page refuses a wrong password', async ({ page, world }) => {
  await page.goto('/login');
  await page.locator('#input_loginId').fill(world.user.username);
  await page.locator('#input_password-input').fill('not-the-password');
  await page.locator('#saveSetting').click();
  await expect(page.getByText(/password is (invalid|incorrect)/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('the member logs in and opens the channel', async ({ page, world }) => {
  await logIn(page, world);
  await page.goto(channelPath(world));
  await expect(page.locator('#post_textbox')).toBeVisible();
});

test('the member posts in the channel and replies in its thread', async ({ page, world }) => {
  await logIn(page, world);
  await page.goto(channelPath(world));

  const message = `UI post ${Date.now()}`;
  await page.locator('#post_textbox').fill(message);
  await page.locator('#post_textbox').press('Enter');
  await expect(page.getByText(message)).toBeVisible();

  const post = await findPost(page.request, world, message);
  await page.locator(`#post_${post.id}`).hover();
  await page.locator(`#CENTER_commentIcon_${post.id}`).click();
  const reply = `UI reply ${Date.now()}`;
  await page.locator('#reply_textbox').fill(reply);
  await page.locator('#reply_textbox').press('Enter');

  await expect
    .poll(async () => {
      const thread = await call<{ order: string[] }>(
        page.request,
        'GET',
        `/api/v4/posts/${post.id}/thread`,
        world.user.auth,
      );
      return thread.order.length;
    })
    .toBe(2);
});

test('a post made through the API appears without a reload', async ({ page, request, world }) => {
  await logIn(page, world);
  await page.goto(channelPath(world));
  await expect(page.locator('#post_textbox')).toBeVisible();

  const message = `Live post ${Date.now()}`;
  await call(request, 'POST', '/api/v4/posts', world.admin, { channel_id: world.channel.id, message });
  await expect(page.getByText(message)).toBeVisible();
});
