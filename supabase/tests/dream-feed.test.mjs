// Disposable loopback PostgreSQL only. Never uses managed database credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
const require=createRequire(import.meta.url),port=process.env.PGTEST_PORT;
function service(withDreamDb) {
  const root=fileURLToPath(new URL('../../src/lib/',import.meta.url)),cache=new Map();
  const load=file=>{
    const full=path.resolve(root,file);
    if(cache.has(full))return cache.get(full).exports;
    const module={exports:{}};cache.set(full,module);
    const source=ts.transpileModule(readFileSync(full,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const dependency=name=>name==='./dev-content-db'?{withDreamDb}:name==='./profile-avatars'?{profileAvatarUrl:async key=>key?'https://fixture.invalid/avatar.jpg':null}:name==='./dream-storage'?{requireMedia(){},tryDreamCleanup:async()=>{},tryOwnerDreamCleanup:async()=>{}}:name.endsWith('.mjs')?require(path.resolve(path.dirname(full),name)):name.startsWith('.')?load(path.resolve(path.dirname(full),name)+'.ts'):require(name);
    vm.runInNewContext(`(function(require,module,exports){${source}\n})`,{Buffer,Date,Map,Set,Error,process:{env:{}}})(dependency,module,module.exports);
    return module.exports;
  };
  return {...load('dream-feed.ts'),...load('dreams.ts'),...load('dream-votes.ts')};
}
for(const stage of ['dev','prod'])test(`${stage} Dream feed: bounded private windows, cursors, live authorization, signals and expiry`,{skip:!port},async()=>{
  const connection={host:'127.0.0.1',port:Number(port),user:'postgres',database:'postgres'};
  const admin=new pg.Pool(connection),database=`feed_${stage}_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const db=new pg.Pool({...connection,database}),role=`ambatu_${stage}_dream_writer`,login=`ambatu_${stage}_content_reader`;
  let reader;
  try {
    for(const name of ['anon','authenticated','service_role',login])if(!(await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[name])).rowCount)await db.query(`CREATE ROLE ${name} LOGIN NOINHERIT`);
    await db.query(readFileSync(new URL('../migrations/001_app_schema.sql',import.meta.url),'utf8'));
    await db.query('CREATE TABLE app.player_blocks(blocker_id text,blocked_id text,PRIMARY KEY(blocker_id,blocked_id));ALTER TABLE app.player_blocks ENABLE ROW LEVEL SECURITY');
    for(const file of stage==='dev'?['017_dev_dreams.sql','018_dev_dream_media.sql','019_dev_dream_media_budget.sql','020_dev_dream_votes.sql','021_dev_dream_feed.sql','022_dev_dream_avatar.sql','023_dev_dream_comments.sql']:['009_dreams.sql','010_dream_media.sql','011_dream_media_budget.sql','012_dream_votes.sql','013_dream_feed.sql','014_dream_avatar.sql','015_dream_comments.sql'])
      await db.query(readFileSync(new URL(`${stage==='dev'?'../migrations/':'../production/'}${file}`,import.meta.url),'utf8'));
    reader=new pg.Pool({...connection,user:login,database,max:6});
    const queries=[];
    const withDreamDb=async callback=>{
      const client=await reader.connect();
      try {await client.query('BEGIN');await client.query(`SET LOCAL ROLE ${role}`);
        const proxy={query:async(sql,args)=>{queries.push({sql,args});return client.query(sql,args);}};
        const result=await callback(proxy);await client.query('COMMIT');return result;
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    const api=service(withDreamDb),ids=[];
    for(let i=0;i<123;i++) {
      const id=randomUUID();ids.push(id);
      // Microsecond-separated timestamps catch Date-parser truncation across windows.
      await db.query("INSERT INTO app.dreams(id,author_id,body,audience,publication,published_at) VALUES($1,$2,'Feed fixture','public','published',timestamptz '2026-01-01 00:00:00.999999+00'-$3*interval '1 microsecond')",[id,`creator-${i%11}`,i]);
    }
    const first=await api.listDreamFeed(null,null);
    assert.equal(first.dreams.length,8);assert(first.nextCursor);assert(!first.nextCursor.includes(ids[0]));
    const freshId=randomUUID();
    await db.query("INSERT INTO app.dreams(id,author_id,body,publication,published_at) SELECT $1,'new-creator','New arrival','published',snapshot_at+interval '1 microsecond' FROM app.dream_feed_windows WHERE id=$2",[freshId,first.nextCursor.split('.')[1]]);
    const repeated=await api.listDreamFeed(null,first.nextCursor);
    const replay=await api.listDreamFeed(null,first.nextCursor);
    assert.deepEqual(repeated,replay,'retrying a cursor preserves window order and continuation');
    await assert.rejects(api.listDreamFeed('another',first.nextCursor),e=>e.status===400);
    const parts=first.nextCursor.split('.');parts[2]='0';
    await assert.rejects(api.listDreamFeed(null,parts.join('.')),e=>e.status===400,'position tampering is rejected');
    await assert.rejects(api.listDreamFeed(null,'invalid'),e=>e.status===400);
    const seen=new Set(first.dreams.map(row=>row.id)),latencies=[];let cursor=first.nextCursor,pages=1;
    while(cursor) {
      const before=performance.now();
      const page=await api.listDreamFeed(null,cursor);latencies.push(performance.now()-before);assert(page.dreams.length<=8);
      if(cursor.split('.')[2]==='48') {
        const concurrent=await Promise.all(Array.from({length:3},()=>api.listDreamFeed(null,cursor)));
        for(const retried of concurrent)assert.deepEqual(retried,page,'concurrent window transitions reuse the saved next window');
      }
      for(const dream of page.dreams){assert(!seen.has(dream.id),'no duplicate across windows');seen.add(dream.id);assert(!('cursor_key'in dream));}
      cursor=page.nextCursor;assert(++pages<30);
    }
    assert.equal(seen.size,123,'microsecond boundaries do not skip candidates');
    assert(!seen.has(freshId),'new arrivals wait for refresh rather than shifting this session');
    assert((await api.listDreamFeed(null,null)).dreams.some(row=>row.id===freshId));
    latencies.sort((a,b)=>a-b);
    console.info(JSON.stringify({fixture:`${stage}-feed`,posts:123,pages,p95Ms:Math.round(latencies[Math.floor(latencies.length*.95)]),maxScan:49}));
    assert(queries.filter(q=>q.sql.includes('FROM app.dreams d WHERE d.publication')).every(q=>q.args.at(-1)===49));
    for(let i=0;i<3;i++)await db.query("INSERT INTO app.dreams(id,author_id,body,publication,published_at) VALUES($1,'creator-0','Profile pagination','published',now()-interval '1 second')",[randomUUID()]);
    const profilePage=await api.authorDreams('creator-0',null,null);
    assert.equal(profilePage.dreams.length,12);assert(profilePage.nextCursor);
    const profileNext=await api.authorDreams('creator-0',null,profilePage.nextCursor);
    assert.equal(new Set([...profilePage.dreams,...profileNext.dreams].map(item=>item.id)).size,15);
    await assert.rejects(api.authorDreams('creator-0','other',profilePage.nextCursor),error=>error.status===400);

    await db.query('TRUNCATE app.dreams CASCADE');
    const own=await api.createDream('viewer',{text:'Only mine',audience:'only_me'},'feed-only-mine');
    await db.query("INSERT INTO app.player_profiles(id,username,birth_date,avatar_key) VALUES('viewer','Viewer','2000-01-01','fixture-avatar')");
    await db.query("UPDATE app.dreams SET pending_edit=$2 WHERE id=$1",[own.id,JSON.stringify({text:'Unpublished replacement',audience:'only_me',attachmentIds:[]})]);
    const friends=await api.createDream('friend',{text:'Friends',audience:'friends'},'feed-friend');
    const hidden=await api.createDream('stranger',{text:'Not mine',audience:'only_me'},'feed-hidden');
    await api.createDream('friend',{text:'Draft',publish:false},'feed-draft');
    await db.query("INSERT INTO app.friendships(player_id,other_player_id,state) VALUES('viewer','friend','accepted'),('friend','viewer','accepted')");
    const privateFeed=await api.listDreamFeed('viewer',null);
    assert.equal(privateFeed.dreams.find(row=>row.id===own.id).authorAvatarUrl,'https://fixture.invalid/avatar.jpg');
    assert.equal((await api.getDream(own.id,'viewer')).authorAvatarUrl,'https://fixture.invalid/avatar.jpg');
    assert(!('avatar_key' in privateFeed.dreams.find(row=>row.id===own.id)));
    assert(privateFeed.dreams.some(row=>row.id===own.id));assert(privateFeed.dreams.some(row=>row.id===friends.id));
    assert.equal(privateFeed.dreams.find(row=>row.id===own.id).text,'Only mine','feed uses the published version, including for the author');
    assert(!privateFeed.dreams.some(row=>row.id===hidden.id));
    assert.equal((await api.authorDreams('viewer',null,null)).dreams.length,0);
    assert.equal((await api.authorDreams('viewer','viewer',null)).dreams.length,1);
    assert.equal((await api.authorDreams('friend','viewer',null)).dreams.length,1);
    assert.equal((await api.authorDreams('friend',null,null)).dreams.length,0);
    assert.equal((await api.authorDreams('friend','stranger',null)).dreams.length,0);
    assert.equal((await api.listDreamFeed(null,null)).dreams.length,0);
    await db.query("INSERT INTO app.player_blocks VALUES('friend','viewer')");
    assert(!(await api.listDreamFeed('viewer',null)).dreams.some(row=>row.id===friends.id));
    await assert.rejects(api.authorDreams('friend','viewer',null),e=>e.status===404);
    await db.query('DELETE FROM app.player_blocks');

    // A saved ranking is never an entitlement: the next pending IDs are rechecked.
    await db.query('TRUNCATE app.dreams CASCADE');
    const fixtures=[];
    for(let i=0;i<18;i++)fixtures.push(await api.createDream(i%2?'friend':'other',{text:`Pending ${i}`},`pending-dream-${i}`));
    const start=await api.listDreamFeed('viewer',null),windowId=start.nextCursor.split('.')[1];
    const window=(await db.query('SELECT ids FROM app.dream_feed_windows WHERE id=$1',[windowId])).rows[0];
    const blockedIds=window.ids.slice(8,16);
    await db.query("UPDATE app.dreams SET audience='only_me' WHERE id=ANY($1::uuid[])",[blockedIds]);
    const empty=await api.listDreamFeed('viewer',start.nextCursor);
    assert.equal(empty.dreams.length,0);assert(empty.nextCursor,'empty filtered pages retain continuation');
    const final=await api.listDreamFeed('viewer',empty.nextCursor);assert.equal(final.dreams.length,2);
    await db.query("UPDATE app.dreams SET audience='friends' WHERE author_id='friend'");
    await db.query("DELETE FROM app.friendships WHERE player_id='viewer'");
    assert(!(await api.listDreamFeed('viewer',null)).dreams.some(row=>row.authorId==='friend'));
    await db.query("UPDATE app.dreams SET moderation='removed' WHERE author_id='other'");
    assert.equal((await api.listDreamFeed('viewer',null)).dreams.length,0);

    // Personalization reads the current vote and current entitlement, not a copied preference profile.
    await db.query('TRUNCATE app.dreams CASCADE');
    const a='00000000-0000-0000-0000-000000000001',b='00000000-0000-0000-0000-000000000002',signal=randomUUID();
    for(const [id,author] of [[a,'taste-a'],[b,'taste-b'],[signal,'taste-a']])
      await db.query("INSERT INTO app.dreams(id,author_id,body,publication,published_at) VALUES($1,$2,'Signal fixture','published',CASE WHEN $1::uuid=$3::uuid THEN now()-interval '1 year' ELSE timestamptz '2026-01-01 00:00:00+00' END)",[id,author,signal]);
    assert.equal((await api.listDreamFeed('taste-viewer',null)).dreams[0].id,b);
    await api.voteDream(signal,'taste-viewer',{value:1},'taste-upvote');
    assert.equal((await api.listDreamFeed('taste-viewer',null)).dreams[0].id,a);
    await api.voteDream(signal,'taste-viewer',{value:-1},'taste-downvote');
    assert.equal((await api.listDreamFeed('taste-viewer',null)).dreams[0].id,b);
    await api.voteDream(signal,'taste-viewer',{value:1},'taste-up-again');
    await db.query("UPDATE app.dreams SET audience='only_me' WHERE id=$1",[signal]);
    assert.equal((await api.listDreamFeed('taste-viewer',null)).dreams[0].id,b,'inaccessible voted content stops supplying affinity');
    await db.query("UPDATE app.dreams SET audience='public' WHERE id=$1",[signal]);
    await api.voteDream(signal,'taste-viewer',{value:0},'taste-undo');
    assert.equal((await api.listDreamFeed('taste-viewer',null)).dreams[0].id,b);

    // Completely inaccessible windows still advance without leaking content or IDs.
    await db.query('TRUNCATE app.dreams CASCADE');
    await db.query("INSERT INTO app.dreams(id,author_id,body,audience,publication,published_at) SELECT gen_random_uuid(),'hidden','Hidden','only_me','published',now()-interval '1 second' FROM generate_series(1,52)");
    const skipped=await api.listDreamFeed(null,null);assert.equal(skipped.dreams.length,0);assert(skipped.nextCursor);
    assert.equal((await api.listDreamFeed(null,skipped.nextCursor)).nextCursor,null);
    const expiredId=skipped.nextCursor.split('.')[1];
    await db.query("UPDATE app.dream_feed_windows SET snapshot_at=now()-interval '16 minutes',expires_at=now()-interval '1 minute' WHERE id=$1",[expiredId]);
    await assert.rejects(api.listDreamFeed(null,skipped.nextCursor),e=>e.code==='FEED_CURSOR_EXPIRED');
    const permissions=(await db.query("SELECT has_table_privilege('anon','app.dream_feed_windows','SELECT') AS allowed")).rows[0];
    assert.equal(permissions.allowed,false);
    const ownWindow=await api.listDreamFeed('deleting',null);
    assert(ownWindow);
    await api.beginPlayerDreamDeletion('deleting');
    const deletingKey=createHash('sha256').update(JSON.stringify(['dream-feed-v1','deleting'])).digest('hex');
    assert.equal((await db.query('SELECT 1 FROM app.dream_feed_windows WHERE viewer_key=$1',[deletingKey])).rowCount,0);
    await assert.rejects(api.listDreamFeed('deleting',null),e=>e.code==='ACCOUNT_UNAVAILABLE');
  } finally {
    await reader?.end();await db.end();await admin.query(`DROP DATABASE ${database} WITH(FORCE)`);
    for(const name of [role,`ambatu_${stage}_dream_worker`,`ambatu_${stage}_dream_media_reader`])
      if((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[name])).rowCount)await admin.query(`DROP ROLE ${name}`);
    await admin.end();
  }
});
