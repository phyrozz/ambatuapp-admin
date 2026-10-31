import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(relative, mocks = {}) {
  const filename = new URL(relative, import.meta.url);
  const evaluatedModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module: evaluatedModule, exports: evaluatedModule.exports, require: name => mocks[name] ?? require(name), Buffer, crypto, URL, Response, Request, process }, { filename: filename.pathname });
  return evaluatedModule.exports;
}
const images = load('./s3-images.ts');
class ContributionError extends Error { constructor(status) { super(); this.status = status; } }
const fields = load('./player-character.ts', { './community-content': { ContributionError }, './s3-images': images });
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const valid = { submissionId: first, name: ' Legend ', title: ' Icon ', bio: ' Story ', tags: ['meme'], status: 'Draft', imageKey: null };

test('character fields match admin schema and reject invalid values and foreign portraits', () => {
  const result = fields.playerCharacterFields(valid, owner);
  assert.equal(result.name, 'Legend'); assert.equal(result.title, 'Icon'); assert.equal(result.bio, 'Story');
  for (const change of [{ name:'' }, { title:'' }, { status:'Admin' }, { tags:Array(11).fill('x') }, { bio:'x'.repeat(20001) }, { imageKey:`characters/player_${other}/${first}/${second}.jpg` }]) {
    assert.throws(() => fields.playerCharacterFields({ ...valid, ...change }, owner), error => error.status === 400);
  }
  assert.equal(images.isPlayerCharacterImageKey(`characters/player_${owner}/${first}/${second}.webp`, owner), true);
});

test('portrait presigning rejects unsupported types, oversized files, and invalid destinations before storage access', async () => {
  for (const [type,size,id] of [['image/gif',10,first], ['image/png',3*1024*1024+1,first], ['image/jpeg',0,first], ['image/png',10,'../other']]) {
    await assert.rejects(images.createPlayerCharacterImageUpload(owner,id,type,size));
  }
});

function fixture() {
  const records = new Map();
  const queries = [];
  const verifiedImages = [];
  const snap = id => ({ id, exists:records.has(id), data:() => records.get(id) });
  function query(filters = [], limit = null, after = null) {
    return {
      doc:id => ({ id, get:async () => snap(id) }),
      where:(field, _op, value) => query([...filters, [field,value]], limit, after),
      orderBy:() => query(filters, limit, after),
      limit:value => query(filters, value, after),
      startAfter:cursor => query(filters, limit, cursor.id),
      get:async () => {
        assert.notEqual(limit, null); queries.push({ filters,limit,after });
        const rows = [...records.keys()].sort().reverse().filter(id => filters.every(([key,value]) => records.get(id)[key] === value));
        const start = after ? rows.indexOf(after)+1 : 0;
        return { docs:rows.slice(start,start+limit).map(snap) };
      },
    };
  }
  const db = { collection:name => { assert.equal(name,'characters'); return query(); }, runTransaction:async work => work({ get:async ref => snap(ref.id), create:(ref,data) => records.set(ref.id,data), update:(ref,data) => records.set(ref.id,{ ...records.get(ref.id), ...data }) }) };
  const common = {
    ContributionError, requireContributionFirestore: () => db, contributionHeaders:{}, contributionBody:request => request.json(),
    contributionPlayer:async request => { if (request.headers.get('authorization') !== 'owner') throw new ContributionError(401); return { id:owner }; },
    contributionError:error => Response.json({ error:'failed' }, { status:error.status ?? 400 }),
    limitContribution:async () => {},
  };
  const mocks = prefix => ({
    'next/server':{ NextResponse: class extends Response { static json = Response.json; } },
    'firebase-admin/firestore':{ FieldPath:{ documentId:() => '__name__' }, FieldValue:{ serverTimestamp:() => null } },
    [`${prefix}/firebase-admin`]:{ adminDb:db },
    [`${prefix}/dev-content-db`]:{ isDevCharacterWriter:() => false },
    [`${prefix}/dev-characters`]:{},
    [`${prefix}/community-content`]:common,
    [`${prefix}/player-character`]:fields,
    [`${prefix}/s3-images`]:{ signedCharacterImageUrl:async () => null, verifyPlayerCharacterImage:async key => { verifiedImages.push(key); if(key.endsWith('/missing.jpg')) throw new Error('missing'); } },
  });
  const route = load('../app/api/public/contributions/characters/route.ts', mocks('../../../../../lib'));
  const edit = load('../app/api/public/contributions/characters/[id]/route.ts', mocks('../../../../../../lib'));
  const request = (body, method = 'POST', url = 'https://test/api', auth = 'owner') => new Request(url, { method, headers:{ authorization:auth, 'content-type':'application/json' }, ...(method === 'GET' ? {} : { body:JSON.stringify(body) }) });
  return { route, edit, records, queries, request, verifiedImages };
}

test('creation requires authentication, stores owner, and retries without duplicate records', async () => {
  const { route,records,request } = fixture();
  assert.equal((await route.POST(request(valid,'POST','https://test','none'))).status,401);
  assert.equal((await route.POST(request(valid))).status,201);
  assert.equal(records.get(first).uploaderId,owner); assert.equal(records.get(first).status,'Draft');
  assert.equal((await route.POST(request(valid))).status,201); assert.equal(records.size,1);
  records.set(first,{ uploaderId:other, source:'revamp' });
  assert.equal((await route.POST(request(valid))).status,409);
});

test('MyDreamy returns drafts and published characters only for this owner, with bounded cursors', async () => {
  const { route,records,request,queries } = fixture();
  records.set(first,{ ...valid,uploaderId:owner,source:'revamp' });
  records.set(second,{ ...valid,status:'Published',uploaderId:owner,source:'revamp' });
  records.set('cccccccc-cccc-4ccc-8ccc-cccccccccccc',{ ...valid,uploaderId:other,source:'revamp' });
  const page = await (await route.GET(request(null,'GET','https://test?limit=1'))).json();
  assert.equal(page.characters.length,1); assert.equal(page.characters[0].id,second); assert.ok(page.nextCursor);
  const next = await (await route.GET(request(null,'GET',`https://test?limit=1&cursor=${page.nextCursor}`))).json();
  assert.equal(next.characters[0].id,first); assert.equal(next.characters[0].status,'Draft'); assert.equal(next.nextCursor,null);
  assert.equal(queries[0].limit,2);
  const foreign = Buffer.from('cccccccc-cccc-4ccc-8ccc-cccccccccccc').toString('base64url');
  assert.equal((await route.GET(request(null,'GET',`https://test?cursor=${foreign}`))).status,400);
});

test('editing publishes an owned draft and rejects other owners', async () => {
  const { edit,records,request } = fixture();
  records.set(first,{ ...valid,uploaderId:owner,source:'revamp' });
  const context = { params:Promise.resolve({ id:first }) };
  assert.equal((await edit.PATCH(request({ ...valid,status:'Published' },'PATCH'),context)).status,200);
  assert.equal(records.get(first).status,'Published'); assert.equal(records.get(first).uploaderId,owner);
  records.set(first,{ ...valid,uploaderId:other,source:'revamp' });
  assert.equal((await edit.PATCH(request(valid,'PATCH'),context)).status,404);
});

test('text edits preserve an existing portrait without storage verification, including an admin replacement', async () => {
  const { edit,records,request,verifiedImages } = fixture();
  const imageKey = 'characters/admin/portrait.png';
  records.set(first,{ ...valid,imageKey,uploaderId:owner,source:'revamp' });
  const context = { params:Promise.resolve({ id:first }) };
  assert.equal((await edit.PATCH(request({ ...valid,imageKey,name:'Updated legend' },'PATCH'),context)).status,200);
  assert.equal(records.get(first).imageKey,imageKey);
  assert.equal(records.get(first).name,'Updated legend');
  assert.deepEqual(verifiedImages,[]);
  const replacement = `characters/player_${owner}/${first}/${second}.png`;
  assert.equal((await edit.PATCH(request({ ...valid,imageKey:replacement },'PATCH'),context)).status,200);
  assert.deepEqual(verifiedImages,[replacement]);
  const foreign = `characters/player_${other}/${first}/${second}.png`;
  assert.equal((await edit.PATCH(request({ ...valid,imageKey:foreign },'PATCH'),context)).status,400);
  assert.equal(records.get(first).imageKey,replacement);
});
