// All mutations are confined to a disposable database on loopback PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
const require = createRequire(import.meta.url), port = process.env.PGTEST_PORT;
const sourceRoot = fileURLToPath(new URL('../../src/lib/', import.meta.url));
function loadService(withDreamDb) {
  const modules = new Map();
  const load = file => {
    const full = path.resolve(sourceRoot, file);
    if (modules.has(full)) return modules.get(full).exports;
    const module = { exports: {} }; modules.set(full,module);
    const code = ts.transpileModule(readFileSync(full,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const dependency = name => name === './dev-content-db' ? { withDreamDb } : name.startsWith('.') ? load(`${path.resolve(path.dirname(full),name)}.ts`) : require(name);
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Buffer, Date, Map, Set, Error })(dependency,module,module.exports);
    return module.exports;
  };
  return load('dreams.ts');
}
for (const stage of ['dev','prod']) test(`${stage} Dream migration: private roles, audience checks, idempotency, edits, cursors and deletion races`, { skip: !port }, async () => {
  const connection = { host:'127.0.0.1', port:Number(port), user:'postgres', database:'postgres' };
  const admin = new pg.Pool(connection), database=`dreams_${stage}_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const db = new pg.Pool({ ...connection,database }), role=`ambatu_${stage}_dream_writer`, login=`ambatu_${stage}_content_reader`;
  let reader;
  try {
    for (const roleName of ['anon','authenticated','service_role',login]) {
      if (!(await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[roleName])).rowCount) await db.query(`CREATE ROLE ${roleName} LOGIN NOINHERIT`);
    }
    await db.query(readFileSync(new URL('../migrations/001_app_schema.sql',import.meta.url),'utf8'));
    await db.query('CREATE TABLE app.player_blocks (blocker_id text,blocked_id text,PRIMARY KEY(blocker_id,blocked_id)); ALTER TABLE app.player_blocks ENABLE ROW LEVEL SECURITY');
    await db.query(readFileSync(new URL(stage==='dev'?'../migrations/017_dev_dreams.sql':'../production/009_dreams.sql',import.meta.url),'utf8'));
    reader = new pg.Pool({ ...connection,user:login,database,max:6 });
    const withDreamDb = async callback => {
      const client=await reader.connect();
      try { await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${role}`); const result=await callback(client); await client.query('COMMIT'); return result; }
      catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    const service = loadService(withDreamDb), author='author', friend='friend', pending='pending', blocked='blocked', stranger='stranger';
    await db.query("INSERT INTO app.player_profiles(id,username,birth_date) VALUES ('author','Author','2000-01-01')");
    await db.query("INSERT INTO app.friendships(player_id,other_player_id,state) VALUES ('author','friend','accepted'),('friend','author','accepted'),('author','pending','outgoing'),('pending','author','incoming')");
    await db.query("INSERT INTO app.player_blocks VALUES ('author','blocked')");
    for (const audience of ['public','friends','only_me']) {
      const dream=await service.createDream(author,{text:`A ${audience} Dream`,audience},`audience-${audience}`);
      for(const viewer of [null,author,friend,pending,blocked,stranger]) {
        const permitted=viewer===author || (viewer!==blocked && (audience==='public' || (audience==='friends'&&viewer===friend)));
        if(permitted) assert.equal((await service.getDream(dream.id,viewer)).text,dream.text);
        else await assert.rejects(service.getDream(dream.id,viewer),error=>error.status===404);
      }
      assert.equal(dream.authorName,'Author'); assert(!('birthDate' in dream));
    }
    const draft=await service.createDream(author,{text:'Private draft',publish:false},'draft-request');
    await assert.rejects(service.getDream(draft.id,null),error=>error.status===404);
    assert.equal((await service.getDream(draft.id,author)).publication,'draft');
    const published=await service.editDream(draft.id,author,{revision:1,publish:true});
    assert.equal((await service.getDream(draft.id,null)).revision,2);
    await service.editDream(draft.id,author,{revision:published.revision,audience:'only_me'});
    await assert.rejects(service.getDream(draft.id,friend),error=>error.status===404);
    await assert.rejects(service.editDream(draft.id,stranger,{revision:3,text:'Stolen'}),error=>error.status===404);
    await assert.rejects(service.deleteDream(draft.id,stranger),error=>error.status===404);
    const same=await Promise.all([service.createDream(author,{text:'Retry safely'},'same-request'),service.createDream(author,{text:'Retry safely'},'same-request')]);
    assert.equal(same[0].id,same[1].id);
    await assert.rejects(service.createDream(author,{text:'Different body'},'same-request'),error=>error.status===409);
    const changes=await Promise.allSettled([service.editDream(same[0].id,author,{revision:1,text:'Edit one'}),service.editDream(same[0].id,author,{revision:1,text:'Edit two'})]);
    assert.equal(changes.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(changes.find(x=>x.status==='rejected').reason.code,'REVISION_CONFLICT');
    await service.deleteDream(same[0].id,author);
    await assert.rejects(service.getDream(same[0].id,null),error=>error.status===404);
    await assert.rejects(service.createDream(author,{text:'Retry safely'},'same-request'),error=>error.status===410);
    const ledger=(await db.query('SELECT * FROM app.dream_requests WHERE author_id=$1 AND request_key=$2',[author,'same-request'])).rows[0];
    assert.equal(ledger.request_hash,null);
    const friendsOnly=await service.createDream(author,{text:'For friends',audience:'friends'},'friends-live');
    await db.query("DELETE FROM app.friendships WHERE player_id='friend' OR other_player_id='friend'");
    await assert.rejects(service.getDream(friendsOnly.id,friend),error=>error.status===404);
    const emoji=String.fromCodePoint(0x1f600).repeat(2000);
    assert.equal((await service.createDream(author,{text:emoji},'emoji-limit')).text,emoji);
    await assert.rejects(service.createDream(author,{text:emoji+'a'},'emoji-over'),error=>error.status===422);
    for(let i=0;i<27;i++) await service.createDream('pager',{text:`Item ${i}`,publish:i%2===0},`pager-key-${i}`);
    await db.query("UPDATE app.dreams SET created_at='2026-11-01T00:00:00.000123Z' WHERE author_id='pager'");
    const first=await service.myDreams('pager',null), second=await service.myDreams('pager',first.nextCursor), third=await service.myDreams('pager',second.nextCursor);
    assert.equal(first.dreams.length,12); assert.equal(second.dreams.length,12); assert.equal(third.dreams.length,3); assert.equal(third.nextCursor,null);
    assert.equal(new Set([...first.dreams,...second.dreams,...third.dreams].map(x=>x.id)).size,27);
    await assert.rejects(service.myDreams('other',first.nextCursor),error=>error.status===400);
    const doomed=await service.createDream('leaving',{text:'Remove with account'},'deleting-dream');
    await Promise.allSettled([service.createDream('leaving',{text:'Racing create'},'deleting-race'),service.beginPlayerDreamDeletion('leaving')]);
    assert.equal((await db.query("SELECT 1 FROM app.dreams WHERE author_id='leaving'")).rowCount,0);
    assert.equal((await db.query("SELECT 1 FROM app.dream_requests WHERE author_id='leaving'")).rowCount,0);
    await assert.rejects(service.createDream('leaving',{text:'Too late'},'deleting-late'),error=>error.status===403);
    await assert.rejects(service.getDream(doomed.id,null),error=>error.status===404);
    await assert.rejects(service.getDream(friendsOnly.id,'leaving'),error=>error.status===404);
    await assert.rejects(reader.query('SELECT * FROM app.dreams'),/permission denied/);
    await assert.rejects(withDreamDb(client=>client.query('SELECT birth_date FROM app.player_profiles')),/permission denied/);
    for(const name of ['anon','authenticated','service_role']) assert.equal((await db.query("SELECT has_table_privilege($1,'app.dreams','SELECT') AS allowed",[name])).rows[0].allowed,false);
  } finally {
    await reader?.end(); await db.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    if((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount) await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  }
});
