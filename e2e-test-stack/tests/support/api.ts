import { expect, type APIRequestContext } from '@playwright/test';

export type Headers = Record<string, string>;

export function bearer(token: string): Headers {
  return { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' };
}

// Logs in and returns the session token. The request's cookies also hold the session afterwards.
export async function login(request: APIRequestContext, loginId: string, password: string): Promise<string> {
  const response = await request.post('/api/v4/users/login', { data: { login_id: loginId, password } });
  expect(response.status(), `login as ${loginId}`).toBe(200);
  const token = response.headers()['token'];
  expect(token, `session token for ${loginId}`).toBeTruthy();
  return token;
}

// Sends a JSON request and returns the parsed body, failing the test on an unexpected status.
export async function call<T>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  headers: Headers,
  data?: unknown,
  status = method === 'POST' ? 201 : 200,
): Promise<T> {
  const response = await request.fetch(path, { method, headers, data });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(status);
  return (await response.json()) as T;
}
