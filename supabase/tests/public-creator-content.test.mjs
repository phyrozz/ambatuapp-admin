// Only a disposable PostgreSQL database on loopback is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url),port=process.env.PGTEST_PORT;
for(const stage of ['dev','prod'])test(`${stage} public creator lore and score queries respect bounded pagination and publication`,{skip:!port},async()=>{
  const connection={host:'127.0.0.1',port:Number(port),user:'postgres',database:'postgres'};
  const admin=new pg.Pool(connection),database=`creator_content_${stage}_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const db=new pg.Pool({...connection,database});
  try {
    await db.query(readFileSync(new URL('../migrations/001_app_schema.sql',import.meta.url),'utf8'));
    const source=readFileSync(fileURLToPath(new URL('../../src/lib/public-creator-content.ts',import.meta.url)),'utf8');
    const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const module={exports:{}};
    const mock=name=>{
      if(name==='firebase-admin/firestore')return {FieldPath:{}};
      if(name==='./firebase-admin')return {adminDb:null};
      if(name==='./dev-content-db')return {isDevLeaderboardWriter:()=>true,isDevLoreWriter:()=>true,withDevLeaderboardDb:fn=>fn(db),withDevLoreDb:fn=>fn(db)};
      if(name==='./player-auth')return {playerFromRequest:async()=>null};
      if(name==='./friend-list')return {validFriendId:value=>typeof value==='string'&&/^[\w-]{1,128}$/.test(value)};
      if(name==='./player-blocks')return {hiddenPlayerIds:async()=>new Set()};
      return require(name);
    };
    vm.runInNewContext(`(function(require,module,exports){${compiled}\n})`,{Buffer,Date,Error,Set,Number})(mock,module,module.exports);
    const api=module.exports,ids=[];
    for(let i=0;i<28;i++) {
      const id=randomUUID();ids.push(id);
      await db.query("INSERT INTO app.content(kind,id,status,source,uploader_id,created_at) VALUES('lore',$1,$2,'revamp','bob',timestamptz '2026-01-01 00:00:00.999999+00'-$3*interval '1 microsecond')",[id,i%7===0?'Draft':'Published',i]);
      await db.query('INSERT INTO app.lores(id,title,body) VALUES($1,$2,$3)',[id,`Title ${i}`,i%7===0?'Private draft':'x'.repeat(500)]);
    }
    let cursor=null;const seen=new Set();
    do {
      const result=await api.creatorPublishedLores('bob',cursor);assert(result.lores.length<=12);
      for(const lore of result.lores){assert(!seen.has(lore.id));seen.add(lore.id);assert(!lore.excerpt.includes('Private draft'));assert(lore.excerpt.length<=200);}
      cursor=result.nextCursor;
    } while(cursor);
    assert.equal(seen.size,24,'all published lore remains reachable at microsecond boundaries');
    const first=await api.creatorPublishedLores('bob',null);
    await assert.rejects(api.creatorPublishedLores('other',first.nextCursor),error=>error.status===400);
    await db.query("INSERT INTO app.leaderboard_entries(game_id,player_id,score) VALUES('ambatutap','bob',99),('ambatusnake','bob',123),('unknown','bob',500),('ambatutap','alice',777)");
    const scores=await api.creatorScores('bob');
    assert.deepEqual(JSON.parse(JSON.stringify(scores)).sort((a,b)=>a.gameId.localeCompare(b.gameId)),[{gameId:'ambatusnake',score:123},{gameId:'ambatutap',score:99}]);
  } finally {await db.end();await admin.query(`DROP DATABASE ${database} WITH(FORCE)`);await admin.end();}
});
