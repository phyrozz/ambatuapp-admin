import test from 'node:test';
import assert from 'node:assert/strict';
import {rankDreams,DREAM_WINDOW} from './dream-ranking.ts';
const now=Date.parse('2026-11-08T00:00:00Z');
const candidate=(id,author,extra={})=>({id,author,publishedAt:now,audience:'public',up:0,down:0,friend:false,vote:0,...extra});
test('Dream ranking is deterministic, vote signals reverse, and restricted popularity is ignored',()=>{
  const rows=[candidate('a','a'),candidate('b','b')];
  assert.equal(rankDreams(rows,[{author:'a',value:1,at:now}], 'viewer',now)[0].id,'a');
  assert.equal(rankDreams(rows,[{author:'a',value:-1,at:now}], 'viewer',now)[0].id,'b');
  assert.equal(rankDreams(rows,[], 'viewer',now)[0].id,'b');
  assert.deepEqual(rankDreams(rows,[],'viewer',now),rankDreams(rows,[],'viewer',now));
  assert.equal(rankDreams([candidate('a','a',{audience:'friends',up:100000}),candidate('b','b',{audience:'friends'})],[],'viewer',now)[0].id,'b');
  assert.equal(rankDreams([candidate('old','a',{publishedAt:now-1000}),candidate('new','b')],[],null,now)[0].id,'new');
});
test('Dream ranking limits repeated authors while alternatives remain and reserves discovery',()=>{
  const rows=Array.from({length:DREAM_WINDOW},(_,i)=>candidate(`id-${i}`,i<30?'prolific':`other-${i}`,{friend:i<30}));
  const result=rankDreams(rows,[],'viewer',now);
  assert.equal(result.length,DREAM_WINDOW);assert.equal(new Set(result.map(row=>row.id)).size,DREAM_WINDOW);
  assert(result.slice(0,8).filter(row=>row.author==='prolific').length<=2);
  assert.equal(result[3].friend,false);assert.equal(result[7].friend,false);
  assert.equal(rankDreams([candidate('a','a'),candidate('b','a'),candidate('c','a')],[],'viewer',now).length,3);
});
