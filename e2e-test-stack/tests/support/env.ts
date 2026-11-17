// The server under test, from the e2e-test-stack action's fetch outputs.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export const siteURL = required('SITE_URL').replace(/\/+$/, '');
export const adminUsername = required('ADMIN_USERNAME');
export const adminPassword = required('ADMIN_PASSWORD');
export const mailToken = required('MAIL_TOKEN');
export const expectLicensed = process.env.EXPECT_LICENSED === 'true';

// Inbucket is served on the site's hostname with a `mail-` prefix.
export const mailURL = (() => {
  const url = new URL(siteURL);
  url.hostname = `mail-${url.hostname}`;
  return url.origin;
})();
