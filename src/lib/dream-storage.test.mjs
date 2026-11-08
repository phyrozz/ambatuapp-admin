import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const require=createRequire(import.meta.url);

test('presigned uploads require exact length and create-only writes without an empty-body checksum',async()=>{
  const real=require('@aws-sdk/client-s3'),module={exports:{}};
  const source=ts.transpileModule(readFileSync(new URL('./dream-storage.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const dependency=name=>{
    if(name==='@aws-sdk/client-s3')return {...real,S3Client:class extends real.S3Client{constructor(options){super({...options,credentials:{accessKeyId:'fixture',secretAccessKey:'fixture'}});}}};
    if(name.includes('cleanup.mjs'))return {};
    if(name==='./dev-content-db')return {isProductionPostgres:()=>false};
    if(name==='./dream-validation')return {DreamError:Error};
    return require(name);
  };
  vm.runInNewContext(`(function(require,module,exports){${source}\n})`,{process:{env:{AMBATUPOST_MEDIA_ENABLED:'true',AMBATUPOST_MEDIA_BASE_URL:'https://fixture.invalid',AWS_S3_CHARACTER_IMAGES_BUCKET:'fixture',NEXT_PUBLIC_AWS_REGION:'ap-southeast-1'}},Error,URL})(dependency,module,module.exports);
  const signed=await module.exports.signDreamUpload('ambatupost/dev/input/fixture/source.png','image/png',4096),url=new URL(signed.uploadUrl);
  assert.equal(url.searchParams.get('X-Amz-Expires'),'300');
  assert.match(url.searchParams.get('X-Amz-SignedHeaders'),/content-length/);
  assert.match(url.searchParams.get('X-Amz-SignedHeaders'),/if-none-match/);
  assert.equal([...url.searchParams.keys()].some(key=>key.includes('checksum')),false);
  assert.equal(signed.uploadHeaders['if-none-match'],'*');
  assert.equal(signed.uploadHeaders['content-type'],'image/png');
});
