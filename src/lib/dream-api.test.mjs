import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const require=createRequire(import.meta.url), root=fileURLToPath(new URL('../',import.meta.url));
const id='c74a7d49-ed8c-4666-819d-91def00b08d1';
function fixture(environment={}) {
  const calls=[], cache=new Map(), env={AMBATUPOST_ENABLED:'true',...environment};
  const load=filename=>{
    const full=path.resolve(root,filename);
    if(cache.has(full))return cache.get(full).exports;
    const module={exports:{}};cache.set(full,module);
    const code=ts.transpileModule(readFileSync(full,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const dependency=name=>{
      if(name.endsWith('/dream-storage'))return {mediaEnabled:()=>false};
      if(name.endsWith('/dream-votes'))return {voteDream:async(...args)=>{calls.push({method:'voteDream',args});return {up:1,down:0,viewerVote:1};}};
      if(name.endsWith('/dream-feed'))return {listDreamFeed:async(...args)=>{calls.push({method:'listDreamFeed',args});return {dreams:[],nextCursor:null};}};
      if(name==='next/server')return {NextResponse:class extends Response {static json(body,init){return new this(JSON.stringify(body),init);}}};
      if(name.endsWith('/player-auth'))return {playerFromRequest:async request=>{
        const token=request.headers.get('authorization');
        if(!token||token==='Bearer ')return null;
        if(token!=='Bearer alice')throw new Error('INVALID_TOKEN');
        return {id:'alice'};
      }};
      if(name.endsWith('/dreams'))return Object.fromEntries(['getDream','createDream','editDream','deleteDream','myDreams','authorDreams'].map(method=>[method,async(...args)=>{calls.push({method,args});return method==='deleteDream'?null:['myDreams','authorDreams'].includes(method)?{dreams:[],nextCursor:null}:{id,text:'Fixture'};}]));
      return name.startsWith('.')?load(`${path.resolve(path.dirname(full),name)}.ts`):require(name);
    };
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`,{Request,Response,URL,Buffer,Date,Error,performance,process:{env}})(dependency,module,module.exports);
    return module.exports;
  };
  const request=(suffix,{token,method='GET',body,key,contentType='application/json'}={})=>new Request(`https://fixture.invalid/api/public/ambatupost${suffix}`,{method,headers:{...(token!==undefined?{authorization:token}:{}),...(body!==undefined?{'content-type':contentType}:{}),...(key?{'idempotency-key':key}:{})},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
  return {load,request,calls};
}
test('feature flag/pilot boundaries and invalid tokens cannot downgrade to public reads',async()=>{
  for(const token of ['Bearer invalid','Bearer ']){
    const f=fixture();const response=await f.load('app/api/public/ambatupost/[id]/route.ts').GET(f.request(`/${id}`,{token}),{params:Promise.resolve({id})});
    assert.equal(response.status,401);assert.equal(f.calls.length,0);
  }
  for(const env of [{AMBATUPOST_ENABLED:'false'},{AMBATUPOST_ALLOWED_PLAYER_IDS:'someone-else'}]){
    const f=fixture(env),r=await f.load('app/api/public/ambatupost/config/route.ts').GET(f.request('/config',{token:'Bearer alice'}));
    assert.equal(r.status,404);assert.equal(f.calls.length,0);
  }
  const pilot=fixture({AMBATUPOST_ALLOWED_PLAYER_IDS:'alice'});
  assert.equal((await pilot.load('app/api/public/ambatupost/config/route.ts').GET(pilot.request('/config',{token:'Bearer alice'}))).status,200);
  assert.equal((await pilot.load('app/api/public/ambatupost/config/route.ts').GET(pilot.request('/config'))).status,404);
});
test('guest reads retain guest identity; writes require a token, valid IDs and an idempotency key',async()=>{
  const f=fixture(),route=f.load('app/api/public/ambatupost/[id]/route.ts');
  const read=await route.GET(f.request(`/${id}`),{params:Promise.resolve({id})});
  assert.equal(read.status,200);assert.equal(f.calls[0].args[1],null);
  assert.match(read.headers.get('cache-control'),/no-store/);assert.equal(read.headers.get('vary'),'Authorization');
  assert.equal((await route.GET(f.request('/invalid'),{params:Promise.resolve({id:'invalid'})})).status,404);
  const create=f.load('app/api/public/ambatupost/route.ts');
  assert.equal((await create.POST(f.request('',{method:'POST',body:{text:'Hi'},key:'valid-key'}))).status,401);
  assert.equal((await create.POST(f.request('',{method:'POST',token:'Bearer alice',body:{text:'Hi'}}))).status,422);
  assert.equal((await create.POST(f.request('',{method:'POST',token:'Bearer alice',body:{text:'Hi'},key:'valid-key'}))).status,201);
  assert.equal(f.calls.at(-1).args[0],'alice');
  assert.equal((await route.DELETE(f.request(`/${id}`,{method:'DELETE',token:'Bearer alice'}),{params:Promise.resolve({id})})).status,204);
});
test('body parsing bounds bytes and validates content type/JSON; preflight supports mutation headers',async()=>{
  const f=fixture(),route=f.load('app/api/public/ambatupost/route.ts');
  const options={method:'POST',token:'Bearer alice',key:'valid-key'};
  assert.equal((await route.POST(f.request('',{...options,body:'not-json'}))).status,422);
  assert.equal((await route.POST(f.request('',{...options,body:'x'.repeat(16385)}))).status,413);
  assert.equal((await route.POST(f.request('',{...options,body:'hello',contentType:'text/plain'}))).status,415);
  const preflight=route.OPTIONS();assert.equal(preflight.status,204);assert.match(preflight.headers.get('access-control-allow-headers'),/idempotency-key/);
});
test('text validation counts Unicode points and rejects forged fields, attachments and broken Unicode',()=>{
  const {dreamBody,dreamCursor}=fixture().load('lib/dream-validation.ts');
  assert.equal(dreamBody({text:String.fromCodePoint(0x1f600).repeat(2000)}).text.length,4000);
  for(const value of [{text:'x'.repeat(2001)},{text:' '},{text:'\u0000'},{text:'\ud800'},{text:'\udc00'},{text:'Hi',authorId:'someone-else'},{text:'Hi',attachmentIds:['image']},{text:'Hi',audience:'unknown'},{text:'Hi',publish:'yes'}])assert.throws(()=>dreamBody(value),error=>error.status===422);
  assert.throws(()=>dreamBody({text:'Edited',revision:0},true),error=>error.status===422);
  const cursor=Buffer.from(JSON.stringify({v:1,owner:'alice',time:'2026-02-31T00:00:00.000000Z',id})).toString('base64url');
  assert.throws(()=>dreamCursor(cursor,'alice'),error=>error.status===400);
});
test('vote route requires authenticated identity and retry key, and never accepts a forged voter',async()=>{
  const f=fixture(),route=f.load('app/api/public/ambatupost/[id]/vote/route.ts'),context={params:Promise.resolve({id})};
  assert.equal((await route.POST(f.request(`/${id}/vote`,{method:'POST',body:{value:1},key:'vote-key-1'}),context)).status,401);
  assert.equal((await route.POST(f.request(`/${id}/vote`,{method:'POST',token:'Bearer alice',body:{value:1}}),context)).status,422);
  const response=await route.POST(f.request(`/${id}/vote`,{method:'POST',token:'Bearer alice',body:{value:1},key:'vote-key-1'}),context);
  assert.equal(response.status,200);assert.equal(f.calls.at(-1).args[1],'alice');assert.match(response.headers.get('cache-control'),/no-store/);
  const {dreamVoteBody}=f.load('lib/dream-validation.ts');
  for(const value of [{value:'1'},{value:2},{value:null},{value:true},{value:1,voter:'other'},[],null])assert.throws(()=>dreamVoteBody(value),e=>e.status===422);
  for(const value of [-1,0,1])assert.equal(dreamVoteBody({value}),value);
});
test('feed guests and members retain verified identity, cursor and private cache headers',async()=>{
  const f=fixture(),route=f.load('app/api/public/ambatupost/feed/route.ts');
  const guest=await route.GET(f.request('/feed'));
  assert.equal(guest.status,200);assert.equal(f.calls.at(-1).args[0],null);
  assert.match(guest.headers.get('cache-control'),/no-store/);assert.match(guest.headers.get('server-timing'),/dream-feed;dur=/);
  assert.equal((await route.GET(f.request('/feed?cursor=opaque',{token:'Bearer alice'}))).status,200);
  assert.deepEqual(Array.from(f.calls.at(-1).args),['alice','opaque']);
  const before=f.calls.length;
  assert.equal((await route.GET(f.request('/feed',{token:'Bearer invalid'}))).status,401);
  assert.equal(f.calls.length,before);
});
test('profile Dream lists pass only the verified viewer and preserve guest access',async()=>{
  const f=fixture(),route=f.load('app/api/public/creators/[id]/dreams/route.ts'),context={params:Promise.resolve({id:'bob'})};
  const guest=await route.GET(f.request('/creators/bob/dreams'),context);
  assert.equal(guest.status,200);assert.equal(f.calls.at(-1).args[1],null);assert.match(guest.headers.get('cache-control'),/no-store/);
  assert.equal((await route.GET(f.request('/creators/bob/dreams?cursor=opaque',{token:'Bearer alice'}),context)).status,200);
  assert.equal(f.calls.at(-1).args[1],'alice');assert.equal(f.calls.at(-1).args[2],'opaque');
  assert.equal((await route.GET(f.request('/creators/bob/dreams',{token:'Bearer invalid'}),context)).status,401);
});
