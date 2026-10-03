import assert from 'node:assert/strict';
import { CognitoIdentityProviderClient, DescribeUserPoolCommand, UpdateUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';

const poolId = process.env.COGNITO_ADMIN_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
if (!poolId || poolId !== process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID) throw new Error('The server and browser admin pool IDs must match.');
const client = new CognitoIdentityProviderClient({ region: poolId.split('_')[0] });
const before = (await client.send(new DescribeUserPoolCommand({ UserPoolId: poolId }))).UserPool;
if (!before) throw new Error('Admin pool not found.');
// UpdateUserPool resets omitted mutable settings. Copy the current configuration.
// https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_UpdateUserPool.html
const settings = ['AccountRecoverySetting', 'AdminCreateUserConfig', 'AutoVerifiedAttributes', 'DeletionProtection', 'DeviceConfiguration', 'EmailConfiguration', 'EmailVerificationMessage', 'EmailVerificationSubject', 'IssuerConfiguration', 'KeyConfiguration', 'LambdaConfig', 'MfaConfiguration', 'Policies', 'SmsAuthenticationMessage', 'SmsConfiguration', 'SmsVerificationMessage', 'UserAttributeUpdateSettings', 'UserPoolAddOns', 'UserPoolTags', 'UserPoolTier', 'VerificationMessageTemplate'];
const input = { UserPoolId: poolId, PoolName: before.Name };
for (const key of settings) if (before[key] !== undefined) input[key] = before[key];
input.AdminCreateUserConfig = { ...before.AdminCreateUserConfig, AllowAdminCreateUserOnly: false };
input.AutoVerifiedAttributes = [...new Set([...(before.AutoVerifiedAttributes ?? []), 'email'])];
// This registration flow collects a verification code.
input.VerificationMessageTemplate = { ...before.VerificationMessageTemplate, DefaultEmailOption: 'CONFIRM_WITH_CODE' };
if (before.VerificationMessageTemplate?.DefaultEmailOption === 'CONFIRM_WITH_LINK') {
  throw new Error('The pool uses verification links. Review the template before switching to code verification.');
}
console.log(JSON.stringify({ apply: process.argv.includes('--apply'), allowSelfSignUp: true, verifyEmail: true, schemaChanges: 0, preservedSettings: settings.filter(key => before[key] !== undefined) }));
if (process.argv.includes('--apply')) {
  await client.send(new UpdateUserPoolCommand(input));
  const after = (await client.send(new DescribeUserPoolCommand({ UserPoolId: poolId }))).UserPool;
  assert.equal(after.AdminCreateUserConfig.AllowAdminCreateUserOnly, false);
  assert.ok(after.AutoVerifiedAttributes.includes('email'));
  assert.deepEqual(after.SchemaAttributes, before.SchemaAttributes);
  for (const key of settings.filter(key => !['AdminCreateUserConfig', 'AutoVerifiedAttributes', 'VerificationMessageTemplate'].includes(key))) {
    assert.deepEqual(after[key], before[key], `Unexpected setting change: ${key}`);
  }
  console.log('Self-registration enabled; attribute schema and existing unrelated settings verified unchanged.');
}
