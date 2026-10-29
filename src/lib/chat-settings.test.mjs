import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const schemaExports = {};
vm.runInNewContext(await compile('./chat-settings-schema.ts'), { exports: schemaExports });
const settingsExports = {};
let sent = [];
class Command { constructor(input) { this.input = input; } }
vm.runInNewContext(await compile('./chat-settings.ts'), {
  exports: settingsExports, process: { env: { CHAT_TABLE: 'dev-table' } },
  require: name => {
    if (name === './chat-settings-schema') return schemaExports;
    if (name === '@aws-sdk/client-dynamodb') return { DynamoDBClient: class {} };
    if (name === '@aws-sdk/lib-dynamodb') return { DynamoDBDocumentClient: { from: () => ({ send: async command => { sent.push(command.input); return {}; } }) }, GetCommand: Command, UpdateCommand: Command };
    throw new Error(name);
  },
});

test('validates complete limits and rejects malformed or unsafe values', () => {
  const defaults = JSON.parse(JSON.stringify(schemaExports.CHAT_LIMIT_DEFAULTS));
  assert.equal(settingsExports.validateLimits(defaults).send.limit, 30);
  for (const invalid of [0, -1, 10001, 1.5, '30']) {
    assert.throws(() => settingsExports.validateLimits({ ...defaults, send: { limit: invalid, seconds: 60 } }));
  }
  assert.throws(() => settingsExports.validateLimits({ ...defaults, send: { limit: 1, seconds: 9 } }));
  assert.throws(() => settingsExports.validateLimits({ ...defaults, extra: { limit: 1, seconds: 60 } }));
});

test('writes use optimistic concurrency and preserve separate settings records', async () => {
  sent = [];
  const limits = settingsExports.validateLimits(JSON.parse(JSON.stringify(schemaExports.CHAT_LIMIT_DEFAULTS)));
  await settingsExports.saveChatSettings(limits, 0, 'admin');
  assert.equal(sent[0].ConditionExpression, 'attribute_not_exists(#version)');
  assert.equal(sent[0].Key.pk, 'SETTINGS#chat');
  assert.equal(sent[0].Key.sk, 'RATE_LIMITS');
  await settingsExports.saveChatSettings(limits, 2, 'admin');
  assert.equal(sent[1].ConditionExpression, '#version = :version');
  assert.equal(sent[1].ExpressionAttributeValues[':version'], 2);
});

test('settings API requires the appropriate permission for each method', async () => {
  const requests = [];
  const api = {};
  vm.runInNewContext(await compile('../app/api/settings/route.ts'), {
    exports: api, Number,
    require: name => {
      if (name === 'next/server') return { NextResponse: { json: value => value } };
      if (name.endsWith('/api-auth')) return { requireAdmin: async (_request, permission) => { requests.push(permission); return { sub: 'admin' }; } };
      if (name.endsWith('/studio-api')) return { studioError: error => { throw error; } };
      if (name.endsWith('/chat-settings')) return { readChatSettings: async () => ({}), validateLimits: value => value, saveChatSettings: async () => ({}) };
      throw new Error(name);
    },
  });
  await api.GET({});
  await api.PUT({ json: async () => ({ version: 0, limits: {} }) });
  assert.equal(requests[0].action, 'view');
  assert.equal(requests[1].action, 'edit');
  assert.equal(requests[1].module, 'settings');
});
