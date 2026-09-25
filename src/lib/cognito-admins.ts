import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { AdminGetUserCommandOutput } from '@aws-sdk/client-cognito-identity-provider';
import { ADMIN_GROUP_NAME } from './admin-constants';

let client: CognitoIdentityProviderClient | undefined;

function userPoolId() {
  const value = process.env.COGNITO_ADMIN_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
  if (!value) throw new Error('Admin Cognito is not configured.');
  return value;
}

function cognito() {
  if (client) return client;
  const poolId = userPoolId();
  // The generic AWS_REGION can be the hosting region, which may differ from
  // the Cognito user pool region. Cognito user pool IDs include their region.
  const region = poolId.split('_')[0];
  client = new CognitoIdentityProviderClient({ region });
  return client;
}

export type AdminUser = {
  username: string;
  sub: string;
  email: string;
  status: string;
  enabled: boolean;
  createdAt: string | null;
};

export async function listAdminUsers(): Promise<AdminUser[]> {
  const poolId = userPoolId();
  const users: AdminUser[] = [];
  let nextToken: string | undefined;
  do {
    const page = await cognito().send(new ListUsersInGroupCommand({
      UserPoolId: poolId,
      GroupName: ADMIN_GROUP_NAME,
      Limit: 60,
      NextToken: nextToken,
    }));
    for (const user of page.Users ?? []) {
      const attributes = Object.fromEntries((user.Attributes ?? []).flatMap(item => item.Name && item.Value !== undefined ? [[item.Name, item.Value]] : []));
      if (!user.Username || !attributes.sub) continue;
      users.push({
        username: user.Username,
        sub: attributes.sub,
        email: attributes.email ?? user.Username,
        status: user.UserStatus ?? 'UNKNOWN',
        enabled: Boolean(user.Enabled),
        createdAt: user.UserCreateDate?.toISOString() ?? null,
      });
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return users.sort((a, b) => a.email.localeCompare(b.email));
}

export async function isCurrentAdmin(username: string) {
  const response = await cognito().send(new AdminListGroupsForUserCommand({ UserPoolId: userPoolId(), Username: username }));
  return (response.Groups ?? []).some(group => group.GroupName === ADMIN_GROUP_NAME);
}

export async function inviteAdmin(emailValue: unknown) {
  const email = typeof emailValue === 'string' ? emailValue.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }

  const poolId = userPoolId();
  const service = cognito();
  let existing: AdminGetUserCommandOutput | undefined;
  try {
    existing = await service.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }));
  } catch (error) {
    if ((error as { name?: string }).name !== 'UserNotFoundException') throw error;
  }

  const existingUsername = existing?.Username;
  if (existingUsername) {
    const attributes = Object.fromEntries((existing?.UserAttributes ?? []).flatMap(item => item.Name && item.Value !== undefined ? [[item.Name, item.Value]] : []));
    if (typeof attributes.email !== 'string' || attributes.email.toLowerCase() !== email) throw new Error('That account does not have this email address.');
    const admins = await listAdminUsers();
    if (admins.some(admin => admin.username === existingUsername)) throw new Error('This account is already an administrator.');
    await service.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: existingUsername, GroupName: ADMIN_GROUP_NAME }));
    return { username: existingUsername, email: attributes.email, invited: false };
  }

  const created = await service.send(new AdminCreateUserCommand({
    UserPoolId: poolId,
    Username: email,
    UserAttributes: [{ Name: 'email', Value: email }],
    DesiredDeliveryMediums: ['EMAIL'],
  }));
  const username = created.User?.Username;
  if (!username) throw new Error('Cognito created the account without returning a username.');
  try {
    await service.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: username, GroupName: ADMIN_GROUP_NAME }));
  } catch (error) {
    await service.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: username })).catch(() => undefined);
    throw error;
  }
  return { username, email, invited: true };
}

export async function removeAdminUser(username: string) {
  await cognito().send(new AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId(), Username: username, GroupName: ADMIN_GROUP_NAME }));
}
