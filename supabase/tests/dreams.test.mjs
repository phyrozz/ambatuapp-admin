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
import { randomUUID,randomBytes,createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { processor,noteObject } from '../../dream-media/processor.mjs';
import { sweepCleanup } from '../../dream-media/cleanup.mjs';
import { mediaServer } from '../../dream-media/gateway.mjs';
import { startWorker,settleWorker,splitRuntime,monthOf } from '../../dream-media/budget.mjs';
const require = createRequire(import.meta.url), port = process.env.PGTEST_PORT;
const sourceRoot = fileURLToPath(new URL('../../src/lib/', import.meta.url));
function loadService(withDreamDb) {
  const modules = new Map();
  const load = file => {
    const full = path.resolve(sourceRoot, file);
    if (modules.has(full)) return modules.get(full).exports;
    const module = { exports: {} }; modules.set(full,module);
    const code = ts.transpileModule(readFileSync(full,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const dependency = name => name === './dev-content-db' ? { withDreamDb } : name === './profile-avatars' ? { profileAvatarUrl:async()=>null } : name === './dream-storage' ? { requireMedia:()=>({namespace:'ambatupost/dev'}),signDreamUpload:async()=>({uploadUrl:'https://fixture.invalid',uploadHeaders:{}}),tryDreamCleanup:async()=>{},tryOwnerDreamCleanup:async()=>{} } : name.endsWith('.mjs') ? require(path.resolve(path.dirname(full),name)) : name.startsWith('.') ? load(`${path.resolve(path.dirname(full),name)}.ts`) : require(name);
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Buffer, Date, Map, Set, Error,URL,process:{env:{AMBATUPOST_MEDIA_BASE_URL:'https://fixture.invalid'}} })(dependency,module,module.exports);
    return module.exports;
  };
  return {...load('dreams.ts'),...load('dream-uploads.ts'),...load('dream-votes.ts')};
}
for (const stage of ['dev','prod']) test(`${stage} Dream migration: private roles, audience checks, idempotency, edits, cursors and deletion races`, { skip: !port }, async () => {
  const connection = { host:'127.0.0.1', port:Number(port), user:'postgres', database:'postgres' };
  const admin = new pg.Pool(connection), database=`dreams_${stage}_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const db = new pg.Pool({ ...connection,database }), role=`ambatu_${stage}_dream_writer`, login=`ambatu_${stage}_content_reader`;
  let reader,worker,mediaReader,gateway;
  try {
    for (const roleName of ['anon','authenticated','service_role',login]) {
      if (!(await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[roleName])).rowCount) await db.query(`CREATE ROLE ${roleName} LOGIN NOINHERIT`);
    }
    await db.query(readFileSync(new URL('../migrations/001_app_schema.sql',import.meta.url),'utf8'));
    await db.query('CREATE TABLE app.player_blocks (blocker_id text,blocked_id text,PRIMARY KEY(blocker_id,blocked_id)); ALTER TABLE app.player_blocks ENABLE ROW LEVEL SECURITY');
    await db.query(readFileSync(new URL(stage==='dev'?'../migrations/017_dev_dreams.sql':'../production/009_dreams.sql',import.meta.url),'utf8'));
    await db.query(readFileSync(new URL(stage==='dev'?'../migrations/018_dev_dream_media.sql':'../production/010_dream_media.sql',import.meta.url),'utf8'));
    await db.query('ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role');
    await db.query(readFileSync(new URL(stage==='dev'?'../migrations/019_dev_dream_media_budget.sql':'../production/011_dream_media_budget.sql',import.meta.url),'utf8'));
    await db.query(readFileSync(new URL(stage==='dev'?'../migrations/020_dev_dream_votes.sql':'../production/012_dream_votes.sql',import.meta.url),'utf8'));
    await db.query(readFileSync(new URL(stage==='dev'?'../migrations/021_dev_dream_feed.sql':'../production/013_dream_feed.sql',import.meta.url),'utf8'));
    await db.query(readFileSync(new URL(stage==='dev'?'../migrations/022_dev_dream_avatar.sql':'../production/014_dream_avatar.sql',import.meta.url),'utf8'));
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
    await assert.rejects(service.voteDream(draft.id,author,{value:1},'draft-vote'),e=>e.status===404);
    const voted=await service.createDream(author,{text:'Vote fixture'},'votes-create');
    const firstVote=await service.voteDream(voted.id,author,{value:1},'self-vote');
    assert.equal(firstVote.up,1);assert.equal(firstVote.viewerVote,1);
    await Promise.all(Array.from({length:20},(_,i)=>service.voteDream(voted.id,`voter-${i}`,{value:i%2?-1:1},`parallel-vote-${i}`)));
    assert.equal((await service.getDream(voted.id,null)).votes.up,11);
    assert.equal((await service.getDream(voted.id,null)).votes.down,10);
    assert.equal((await service.getDream(voted.id,null)).votes.viewerVote,0);
    await Promise.all(Array.from({length:6},()=>service.voteDream(voted.id,author,{value:-1},'switch-once')));
    assert.equal((await service.getDream(voted.id,author)).votes.down,11);
    const delayed=await service.voteDream(voted.id,author,{value:1},'self-vote');
    assert.equal(delayed.viewerVote,-1,'a delayed old receipt cannot undo a newer vote');
    await assert.rejects(service.voteDream(voted.id,author,{value:0},'self-vote'),e=>e.status===409);
    await service.voteDream(voted.id,author,{value:0},'remove-vote');
    assert.equal((await service.getDream(voted.id,author)).votes.viewerVote,0);
    await Promise.all(Array.from({length:12},(_,i)=>service.voteDream(voted.id,author,{value:i%2?1:-1},`competing-switch-${i}`)));
    const actual=(await db.query('SELECT count(*) FILTER(WHERE value=1)::integer AS up,count(*) FILTER(WHERE value=-1)::integer AS down FROM app.dream_votes WHERE dream_id=$1',[voted.id])).rows[0];
    const totals=(await service.getDream(voted.id,author)).votes;
    assert.equal(totals.up,actual.up);assert.equal(totals.down,actual.down);
    await service.voteDream(voted.id,author,{value:0},'clear-competing-switch');
    await assert.rejects(service.voteDream(voted.id,blocked,{value:1},'blocked-vote'),e=>e.status===404);
    await service.editDream(voted.id,author,{revision:1,audience:'friends'});
    await assert.rejects(service.voteDream(voted.id,'voter-0',{value:1},'parallel-vote-0'),e=>e.status===404,'retries must recheck current audience');
    await service.voteDream(voted.id,friend,{value:1},'friend-vote');
    await db.query("UPDATE app.friendships SET state='incoming' WHERE player_id=$1 AND other_player_id=$2",[friend,author]);
    await assert.rejects(service.voteDream(voted.id,friend,{value:0},'unfriend-vote'),e=>e.status===404);
    await db.query("UPDATE app.friendships SET state='accepted' WHERE player_id=$1 AND other_player_id=$2",[friend,author]);
    await service.beginPlayerDreamDeletion('voter-0');
    assert.equal((await service.getDream(voted.id,author)).votes.up,10,'account vote cleanup adjusts surviving counts');
    await assert.rejects(service.voteDream(voted.id,'voter-0',{value:1},'deleted-voter'),e=>e.status===404);
    await service.editDream(voted.id,author,{revision:2,audience:'public'});
    await db.query("INSERT INTO app.dream_vote_budgets(voter_id,minute_requests) VALUES('limited-voter',60)");
    await assert.rejects(service.voteDream(voted.id,'limited-voter',{value:1},'limited-vote'),e=>e.status===429);
    await db.query("INSERT INTO app.dream_vote_budgets(voter_id,day_requests) VALUES('day-limited-voter',1000)");
    await assert.rejects(service.voteDream(voted.id,'day-limited-voter',{value:1},'daily-limited'),e=>e.status===429);
    await db.query("UPDATE app.dreams SET moderation='removed' WHERE id=$1",[voted.id]);
    await assert.rejects(service.voteDream(voted.id,author,{value:1},'removed-vote'),e=>e.status===404);
    for(const table of ['dream_votes','dream_vote_requests','dream_vote_budgets']) {
      const exposed=await db.query("SELECT has_table_privilege('anon',$1,'SELECT') OR has_table_privilege('authenticated',$1,'INSERT') AS exposed",[`app.${table}`]);
      assert.equal(exposed.rows[0].exposed,false);
    }
    await service.deleteDream(voted.id,author);
    assert.equal((await db.query('SELECT 1 FROM app.dream_votes WHERE dream_id=$1',[voted.id])).rowCount,0);
    assert.equal((await db.query('SELECT 1 FROM app.dream_vote_requests WHERE dream_id=$1',[voted.id])).rowCount,0);
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
    // Phase 4 uses actual SQL roles/policies and an in-memory S3 boundary.
    worker=new pg.Pool({...connection,database,user:`ambatu_${stage}_dream_worker`,max:3});
    mediaReader=new pg.Pool({...connection,database,user:`ambatu_${stage}_dream_media_reader`});
    const transaction=async callback=>{const client=await worker.connect();try{await client.query('BEGIN');const value=await callback(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
    const namespace=`ambatupost/${stage}`,objects=new Map();let puts=0,failPut=false;
    const s3={send:async command=>{
      const input=command.input,name=command.constructor.name;
      if(name==='HeadObjectCommand'){if(!objects.has(input.Key)){const error=new Error('NotFound');error.name='NotFound';throw error;}return {ContentLength:objects.get(input.Key).length,ETag:'fixture'};}
      if(name==='GetObjectCommand'){const bytes=objects.get(input.Key),range=input.Range?.match(/^bytes=(\d+)-(\d+)$/);return {Body:Readable.from(range?bytes.subarray(Number(range[1]),Number(range[2])+1):bytes)};}
      if(name==='PutObjectCommand'){puts++;if(failPut&&input.Key.endsWith('thumbnail.jpg'))throw new Error('storage outage');const chunks=[];for await(const chunk of input.Body)chunks.push(chunk);objects.set(input.Key,Buffer.concat(chunks));return {};}
      if(name==='DeleteObjectCommand'){objects.delete(input.Key);return {};}
      if(name==='DeleteObjectsCommand'){for(const object of input.Delete.Objects)objects.delete(object.Key);return {};}
      throw new Error(`Unexpected command ${name}`);
    }};
    let transformGate=null;
    const transform=async(source,directory)=>{if(transformGate)await transformGate();const file=path.join(directory,'media'),thumbnail=path.join(directory,'thumb');await writeFile(file,'media-bytes');await writeFile(thumbnail,'thumbnail');return {file,thumbnail,bytes:11,width:32,height:24,duration:null};};
    const processInput=processor({transaction,s3,bucket:'fixture',namespace,transform});
    const reserve=async owner=>{
      const id=randomUUID(),key=`${namespace}/input/${'a'.repeat(32)}/${id}/${randomUUID()}/source.png`;
      await db.query("INSERT INTO app.dream_attachments(id,owner_id,kind,content_type,declared_bytes,input_key,upload_expires_at) VALUES($1,$2,'image','image/png',6,$3,now()+interval '5 minutes')",[id,owner,key]);
      objects.set(key,Buffer.from('source'));return {id,key};
    };
    const firstMedia=await reserve('media-owner'),secondMedia=await reserve('media-owner');
    const mediaDream=await service.createDream('media-owner',{text:'',attachmentIds:[firstMedia.id,secondMedia.id]},'mixed-media-create');
    assert.equal(mediaDream.publication,'processing');
    await assert.rejects(service.getDream(mediaDream.id,null),error=>error.status===404);
    await processInput(firstMedia.key);assert.equal((await service.getDream(mediaDream.id,'media-owner')).publication,'processing');
    await processInput(secondMedia.key);const publishedMedia=await service.getDream(mediaDream.id,null);
    assert.equal(publishedMedia.publication,'published');assert.equal(publishedMedia.attachments.length,2);
    assert(publishedMedia.attachments.every(a=>a.state==='ready'&&!('input_key'in a)&&!('output_prefix'in a)));
    const publicSession=await service.createDreamMediaSession(mediaDream.id,null,{});
    assert.equal(publicSession.media.length,2);assert.match(publicSession.token,/^[a-f0-9]{64}$/);
    assert.equal((await service.createDreamMediaSession(mediaDream.id,null,{token:publicSession.token})).token,publicSession.token,'renewal keeps an existing media URL stable');
    const priorPuts=puts;await processInput(firstMedia.key);assert.equal(puts,priorPuts,'duplicate events cannot replace ready objects');
    const replacement=await reserve('media-owner');
    const editedMedia=await service.editDream(mediaDream.id,'media-owner',{revision:publishedMedia.revision,text:'Replacement caption',audience:'friends',attachmentIds:[replacement.id],publish:true});
    assert.equal(editedMedia.publication,'processing');
    await assert.rejects(service.getDream(mediaDream.id,null),error=>error.status===404);
    await assert.rejects(service.createDreamMediaSession(mediaDream.id,null,{}),error=>error.status===404);
    await db.query("INSERT INTO app.friendships(player_id,other_player_id,state) VALUES('media-owner','media-friend','accepted'),('media-friend','media-owner','accepted')");
    assert.equal((await service.getDream(mediaDream.id,'media-friend')).text,'','pending replacement cannot leak its new caption');
    const token=(await service.createDreamMediaSession(mediaDream.id,'media-friend',{})).token;
    await assert.rejects(service.createDreamMediaSession(mediaDream.id,'media-friend',{token:publicSession.token}),error=>error.status===404,'a guest capability cannot be renewed as another identity');
    gateway=mediaServer({query:(sql,args)=>mediaReader.query(sql,args),s3,bucket:'fixture',enabled:()=>true});
    await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
    const mediaUrl=`http://127.0.0.1:${gateway.address().port}/media/${firstMedia.id}?grant=${token}`;
    const range=await fetch(mediaUrl,{headers:{range:'bytes=2-5'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 2-5/11');assert.equal(await range.text(),'dia-');assert.match(range.headers.get('cache-control'),/no-store/);
    const head=await fetch(mediaUrl,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    assert.equal((await fetch(mediaUrl,{headers:{range:'bytes=99-'}})).status,416);
    assert.equal((await fetch(mediaUrl.replace(firstMedia.id,replacement.id))).status,404,'grant cannot cover another attachment');
    await db.query("INSERT INTO app.player_blocks VALUES('media-owner','media-friend')");
    assert.equal((await fetch(mediaUrl)).status,404,'a previously issued media grant cannot bypass a new block');
    await db.query("DELETE FROM app.player_blocks WHERE blocker_id='media-owner'");
    await db.query("DELETE FROM app.friendships WHERE player_id='media-friend'");
    assert.equal((await fetch(mediaUrl)).status,404,'media requests check current reciprocal friendship');
    await db.query("INSERT INTO app.friendships(player_id,other_player_id,state) VALUES('media-friend','media-owner','accepted')");
    await processInput(replacement.key);
    assert.equal((await service.getDream(mediaDream.id,'media-friend')).text,'Replacement caption');
    assert.equal((await fetch(mediaUrl)).status,404,'replaced attachments cannot use old grants');
    const racingAttachment=await reserve('media-racing');
    const racingDream=await service.createDream('media-racing',{attachmentIds:[racingAttachment.id]},'media-delete-race');
    let unblock,started;const blockedTransform=new Promise(resolve=>{unblock=resolve;});const transforming=new Promise(resolve=>{started=resolve;});
    transformGate=async()=>{started();await blockedTransform;};
    const running=processInput(racingAttachment.key);await transforming;
    const oldPrefix=(await db.query('SELECT output_prefix FROM app.dream_attachments WHERE id=$1',[racingAttachment.id])).rows[0].output_prefix;
    const deletion=await service.deleteDream(racingDream.id,'media-racing');assert.equal(deletion.state,'pending');
    const putsBefore=puts;unblock();await running;transformGate=null;assert.equal(puts,putsBefore,'deletion fences every output write');
    const failingAttachment=await reserve('media-failure');
    const failedDream=await service.createDream('media-failure',{attachmentIds:[failingAttachment.id]},'media-failure-create');
    failPut=true;await processInput(failingAttachment.key);failPut=false;
    assert.equal((await service.getDream(failedDream.id,'media-failure')).publication,'failed');
    assert.equal((await service.dreamUpload('media-failure',failingAttachment.id)).error,'PROCESSING_FAILED');
    await assert.rejects(service.dreamUpload('other',failingAttachment.id),error=>error.status===404);
    await service.changeDreamUpload('media-failure',failingAttachment.id,true);await processInput(failingAttachment.key);
    assert.equal((await service.getDream(failedDream.id,null)).publication,'published');
    const retriedDeletion=await service.deleteDream(failedDream.id,'media-failure');
    await db.query("UPDATE app.dream_media_jobs SET not_before=now()-interval '1 minute' WHERE owner_id='media-failure'");
    await transaction(client=>sweepCleanup(client,s3,'fixture',namespace,retriedDeletion.operationId));
    assert.equal((await db.query('SELECT state FROM app.dream_media_jobs WHERE id=$1',[retriedDeletion.operationId])).rows[0].state,'pending','completion must wait for older generation/input cleanup jobs');
    const earlier=(await db.query("SELECT id FROM app.dream_media_jobs WHERE owner_id='media-failure' ORDER BY created_at,id")).rows;
    for(const job of earlier)await transaction(client=>sweepCleanup(client,s3,'fixture',namespace,job.id));
    await transaction(client=>sweepCleanup(client,s3,'fixture',namespace,retriedDeletion.operationId));
    assert.equal((await db.query('SELECT state FROM app.dream_media_jobs WHERE id=$1',[retriedDeletion.operationId])).rows[0].state,'complete');
    await assert.rejects(service.reserveDreamUpload('media-owner',{kind:'image',contentType:'image/png',bytes:10485761}),error=>error.status===422);
    await assert.rejects(service.reserveDreamUpload('media-owner',{kind:'video',contentType:'video/mp4',bytes:209715201}),error=>error.status===422);
    const quotaUpload=await service.reserveDreamUpload('quota-owner',{kind:'image',contentType:'image/png',bytes:6});
    await service.changeDreamUpload('quota-owner',quotaUpload.id,false);
    assert.equal((await db.query("SELECT requests FROM app.dream_upload_budgets WHERE owner_id='quota-owner'")).rows[0].requests,1,'deleting a reservation cannot reset its upload budget');
    await db.query("UPDATE app.dream_upload_budgets SET requests=200 WHERE owner_id='quota-owner'");
    await assert.rejects(service.reserveDreamUpload('quota-owner',{kind:'image',contentType:'image/png',bytes:6}),error=>error.code==='UPLOAD_QUOTA');
    await assert.rejects(service.createDream('other',{attachmentIds:[replacement.id]},'steal-media-key'),error=>error.status===422);
    const unbound=await reserve('leaving-media');
    await service.beginPlayerDreamDeletion('leaving-media');
    await processInput(unbound.key);assert.equal(objects.has(unbound.key),false,'late input from a deleted account is removed');
    const cleanupJobs=(await db.query("SELECT id FROM app.dream_media_jobs WHERE owner_id='media-racing'")).rows;
    assert(cleanupJobs.length>0);
    for(const job of cleanupJobs)await transaction(client=>sweepCleanup(client,s3,'fixture',namespace,job.id));
    assert.equal(objects.has(racingAttachment.key),false);
    assert.equal((await db.query('SELECT state FROM app.dream_media_jobs WHERE id=$1',[deletion.operationId])).rows[0].state,'pending','cleanup cannot claim completion before upload/processing fences expire');
    await db.query("UPDATE app.dream_media_jobs SET not_before=now()-interval '1 minute' WHERE owner_id='media-racing'");
    for(const job of cleanupJobs)await transaction(client=>sweepCleanup(client,s3,'fixture',namespace,job.id));
    const complete=(await db.query('SELECT * FROM app.dream_media_jobs WHERE id=$1',[deletion.operationId])).rows[0];assert.equal(complete.state,'complete');assert.equal(complete.prefixes.length,0);
    const lateOutput=`${oldPrefix}media.jpg`;objects.set(lateOutput,Buffer.from('late'));
    await noteObject({transaction,s3,bucket:'fixture',namespace},lateOutput);assert.equal(objects.has(lateOutput),false,'output events remove late commits even after an earlier cleanup completed');
    await assert.rejects(mediaReader.query("UPDATE app.dreams SET body='stolen'"),/permission denied/);
    await assert.rejects(worker.query('SELECT birth_date FROM app.player_profiles'),/permission denied/);
    for(const name of ['anon','authenticated','service_role'])for(const table of ['dream_attachments','dream_media_sessions','dream_media_jobs','dream_upload_budgets'])assert.equal((await db.query('SELECT has_table_privilege($1,$2,\'SELECT\') AS allowed',[name,`app.${table}`])).rows[0].allowed,false);
    // Real PostgreSQL verifies the shared limits and narrow SECURITY DEFINER
    // privileges; these checks use the same roles as deployed Lambda/tasks.
    const month=monthOf(new Date());
    await db.query('INSERT INTO app.dream_media_costs(month) VALUES($1) ON CONFLICT DO NOTHING',[month]);
    for(const name of ['anon','authenticated','service_role',login]) {
      assert.equal((await db.query("SELECT has_function_privilege($1,'app.dream_media_begin()','EXECUTE') AS allowed",[name])).rows[0].allowed,false);
      for(const table of ['dream_media_costs','dream_worker_control','dream_gateway_leases'])assert.equal((await db.query("SELECT has_table_privilege($1,$2,'SELECT') AS allowed",[name,`app.${table}`])).rows[0].allowed,false);
    }
    await assert.rejects(mediaReader.query("UPDATE app.dream_media_costs SET uploads=0"),/permission denied/);
    await assert.rejects(mediaReader.query("SELECT app._dream_media_charge('upload',1)"),/permission denied/);
    await db.query('UPDATE app.dream_media_costs SET requests=49999,gateway_seconds=0 WHERE month=$1',[month]);
    const simultaneous=await Promise.all(Array.from({length:8},()=>mediaReader.query('SELECT app.dream_media_begin() AS lease')));
    const leases=simultaneous.map(result=>result.rows[0].lease).filter(Boolean);
    assert.equal(leases.length,1,'concurrent gateway requests cannot exceed shared request limit');
    await mediaReader.query('SELECT app.dream_media_finish($1)',[leases[0]]);
    const refunded=(await db.query('SELECT gateway_seconds FROM app.dream_media_costs WHERE month=$1',[month])).rows[0].gateway_seconds;
    assert(refunded>=1 && refunded<180);
    await mediaReader.query('SELECT app.dream_media_finish($1)',[leases[0]]);
    assert.equal((await db.query('SELECT gateway_seconds FROM app.dream_media_costs WHERE month=$1',[month])).rows[0].gateway_seconds,refunded,'one lease cannot refund twice');
    await db.query('UPDATE app.dream_media_costs SET requests=0,gateway_seconds=99821,delivery_bytes=0 WHERE month=$1',[month]);
    assert.equal((await mediaReader.query('SELECT app.dream_media_begin() AS lease')).rows[0].lease,null,'reserve full invocation timeout before streaming');
    await db.query('UPDATE app.dream_media_costs SET gateway_seconds=0,delivery_bytes=10737418235 WHERE month=$1',[month]);
    const deliveries=await Promise.all(Array.from({length:5},()=>mediaReader.query('SELECT app.dream_media_delivery(3) AS allowed')));
    assert.equal(deliveries.filter(result=>result.rows[0].allowed).length,1,'concurrent ranges cannot overspend delivery budget');
    await db.query('UPDATE app.dream_media_costs SET uploads=199,upload_bytes=0 WHERE month=$1',[month]);
    const last=await service.reserveDreamUpload('budget-owner',{kind:'image',contentType:'image/png',bytes:6});
    await service.changeDreamUpload('budget-owner',last.id,false);
    await assert.rejects(service.reserveDreamUpload('another-budget-owner',{kind:'image',contentType:'image/png',bytes:6}),error=>error.code==='UPLOAD_QUOTA');
    assert.equal((await db.query('SELECT uploads FROM app.dream_media_costs WHERE month=$1',[month])).rows[0].uploads,200,'deleting an upload cannot reset global usage');
    await db.query('UPDATE app.dream_media_costs SET uploads=0,upload_bytes=1073741819 WHERE month=$1',[month]);
    await assert.rejects(service.reserveDreamUpload('byte-budget-owner',{kind:'image',contentType:'image/png',bytes:6}),error=>error.code==='UPLOAD_QUOTA');
    await db.query('UPDATE app.dream_media_costs SET upload_bytes=0 WHERE month=$1',[month]);
    const retainedJob=randomUUID();
    await db.query("INSERT INTO app.dream_media_jobs(id,owner_id,attachment_ids,prefixes,not_before,reserved_bytes) VALUES($1,'failed-storage-cleanup','{}','{}',now(),5368709120)",[retainedJob]);
    await assert.rejects(service.reserveDreamUpload('storage-budget-owner',{kind:'image',contentType:'image/png',bytes:6}),error=>error.code==='UPLOAD_QUOTA','pending deletion bytes still count until storage cleanup completes');
    await transaction(client=>sweepCleanup(client,s3,'fixture',namespace,retainedJob));
    assert.equal(Number((await db.query('SELECT reserved_bytes FROM app.dream_media_jobs WHERE id=$1',[retainedJob])).rows[0].reserved_bytes),0);
    await db.query('UPDATE app.dream_media_costs SET worker_seconds=0,worker_starts=0 WHERE month=$1',[month]);
    await db.query("UPDATE app.dream_attachments SET state='failed'");
    const pendingInput=await db.query("INSERT INTO app.dream_attachments(id,owner_id,kind,content_type,declared_bytes,input_key,upload_expires_at,input_received) VALUES($1,'batch-owner','image','image/png',6,$2,now()+interval '5 minutes',true) RETURNING id",[randomUUID(),`ambatupost/${stage}/input/budget/source.png`]);
    const previous={...process.env};
    Object.assign(process.env,{WORKER_CLUSTER:'fixture-cluster',WORKER_TASK_DEFINITION:'fixture-task',WORKER_SUBNETS:'subnet-fixture',WORKER_SECURITY_GROUP:'sg-fixture'});
    const requests=[];let networkFailure=true;
    const ecs={send:async command=>{if(command.constructor.name==='RunTaskCommand'){requests.push(command.input);if(networkFailure){networkFailure=false;throw new Error('network timeout after acceptance');}return {tasks:[{taskArn:'fixture-arn'}]};}if(command.constructor.name==='DescribeTasksCommand')return {tasks:[{lastStatus:'STOPPED',stoppedAt:new Date()}]};throw new Error('unexpected ECS command');}};
    try {
      await assert.rejects(startWorker({transaction,ecs}),/network timeout/);
      const retried=await Promise.all([startWorker({transaction,ecs}),startWorker({transaction,ecs})]);
      assert(retried.includes('fixture-arn'));
      for(const request of requests)assert.deepEqual(request,requests[0],'RunTask retry persists identical token and overrides');
      assert.equal((await db.query('SELECT worker_starts FROM app.dream_media_costs WHERE month=$1',[month])).rows[0].worker_starts,1);
      await settleWorker({transaction,ecs});
      assert((await db.query('SELECT worker_seconds FROM app.dream_media_costs WHERE month=$1',[month])).rows[0].worker_seconds>=60,'Fargate has a one-minute minimum');
      assert.equal((await db.query('SELECT lease_id FROM app.dream_worker_control')).rows[0].lease_id,null);
      await db.query('UPDATE app.dream_media_costs SET worker_seconds=21600 WHERE month=$1',[month]);
      assert.equal(await startWorker({transaction,ecs}),null,'no task starts beyond monthly processing limit');
      assert.deepEqual(splitRuntime('2026-01-31T23:59:58Z','2026-02-01T00:00:03Z'),[{month:'2026-01-01',seconds:2},{month:'2026-02-01',seconds:3}]);
      if(stage==='dev') {
        await db.query("UPDATE app.dream_attachments SET state='failed'");
        await db.query("INSERT INTO app.migration_runs(id,source_project,source_count,source_fingerprint) VALUES('firestore-dev-v1','ambatuapp-dev',0,'local-fixture') ON CONFLICT DO NOTHING");
        const batchLease=randomUUID(),deadline=new Date(Date.now()+60000);
        await db.query('UPDATE app.dream_worker_control SET lease_id=$1,deadline=$2',[batchLease,deadline]);
        const beforeExit=Date.now();
        await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../../dream-media/worker.mjs',import.meta.url))],{
          windowsHide:true,timeout:20000,
          env:{...process.env,STAGE:'dev',MEDIA_BUCKET:'fixture',DREAM_MEDIA_LOCAL_TEST:'1',AWS_EC2_METADATA_DISABLED:'true',WORKER_LEASE_ID:batchLease,WORKER_DEADLINE:deadline.toISOString(),DATABASE_CONFIG:JSON.stringify({...connection,database,user:'ambatu_dev_dream_worker'})},
        });
        assert(Date.now()-beforeExit<20000,'real worker exits after its bounded idle grace instead of running forever');
        await db.query('UPDATE app.dream_worker_control SET lease_id=NULL,deadline=NULL');
      }
    } finally {
      for(const key of ['WORKER_CLUSTER','WORKER_TASK_DEFINITION','WORKER_SUBNETS','WORKER_SECURITY_GROUP'])if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
      await db.query('DELETE FROM app.dream_attachments WHERE id=$1',[pendingInput.rows[0].id]);
    }
  } finally {
    if(gateway)await new Promise(resolve=>gateway.close(resolve));
    await worker?.end();await mediaReader?.end();
    await reader?.end(); await db.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    if((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount) await admin.query(`DROP ROLE ${role}`);
    for(const suffix of ['worker','media_reader'])if((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[`ambatu_${stage}_dream_${suffix}`])).rowCount) await admin.query(`DROP ROLE ambatu_${stage}_dream_${suffix}`);
    await admin.end();
  }
});
