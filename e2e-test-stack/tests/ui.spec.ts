import type { Page } from '@playwright/test';

import { expect, test, type World } from './support/fixtures';

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
