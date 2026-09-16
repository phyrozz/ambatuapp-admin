'use client';

import { Amplify } from 'aws-amplify';

export function configureAuth() {
  if (typeof window === 'undefined') return false;
  const userPoolId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
  const userPoolClientId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID;
  if (!userPoolId || !userPoolClientId) return false;
  Amplify.configure({ Auth: { Cognito: { userPoolId: userPoolId.trim(), userPoolClientId: userPoolClientId.trim(), loginWith: { email: true } } } });
  return true;
}

export const authConfigured = () => Boolean(process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID && process.env.NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID);
