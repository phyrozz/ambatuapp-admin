import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
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

export async function isCurrentAdmin(username: string) {
  let nextToken: string | undefined;
  do {
    const response = await cognito().send(new AdminListGroupsForUserCommand({ UserPoolId: userPoolId(), Username: username, NextToken: nextToken }));
    if ((response.Groups ?? []).some(group => group.GroupName === ADMIN_GROUP_NAME)) return true;
    nextToken = response.NextToken;
  } while (nextToken);
  return false;
}

export async function removeAdminUser(username: string) {
  await cognito().send(new AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId(), Username: username, GroupName: ADMIN_GROUP_NAME }));
}

export async function addStudioMembership(username: string) {
  await cognito().send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId(), Username: username, GroupName: ADMIN_GROUP_NAME }));
}

export async function createStudioCognitoUser(email: string, password: string) {
  const service = cognito(), poolId = userPoolId();
  const result = await service.send(new AdminCreateUserCommand({ UserPoolId: poolId, Username: email, UserAttributes: [{ Name: 'email', Value: email }], MessageAction: 'SUPPRESS' }));
  const username = result.User?.Username;
  const sub = result.User?.Attributes?.find(attribute => attribute.Name === 'sub')?.Value;
  if (!username || !sub) throw new Error('studio.errors.request');
  try {
    await service.send(new AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: username, Password: password, Permanent: true }));
    await addStudioMembership(username);
  } catch (error) {
    await deleteStudioCognitoUser(username);
    throw error;
  }
  return { username, sub, email };
}

export async function deleteStudioCognitoUser(username: string) {
  await cognito().send(new AdminDeleteUserCommand({ UserPoolId: userPoolId(), Username: username }));
}
