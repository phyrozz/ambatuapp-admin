'use client';
import { fetchAuthSession } from 'aws-amplify/auth';
import { authConfigured, configureAuth } from './auth';
export async function studioApi(path: string, options?: RequestInit) {
  configureAuth();
  const token = authConfigured() ? (await fetchAuthSession()).tokens?.idToken?.toString() : undefined;
  const response = await fetch(path, { ...options, cache: 'no-store', headers: { ...(options?.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...options?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' && data.error.startsWith('studio.') ? data.error : 'studio.errors.request');
  return data;
}
export function authErrorKey(error: unknown) {
  if (error instanceof Error && error.message.startsWith('studio.')) return error.message;
  const name = (error as { name?: string })?.name;
  return ({ UsernameExistsException: 'studio.errors.accountExists', InvalidPasswordException: 'studio.errors.invalidPassword', CodeMismatchException: 'studio.errors.invalidCode', ExpiredCodeException: 'studio.errors.invalidCode', NotAuthorizedException: 'studio.errors.authentication', TooManyRequestsException: 'studio.errors.rateLimit', LimitExceededException: 'studio.errors.rateLimit' } as Record<string, string>)[name ?? ''] ?? 'studio.errors.authentication';
}
