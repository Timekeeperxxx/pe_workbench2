import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {verifyQuoteIdentity,createWestockTool} from '../lib/westock-tool.mjs';
const raw='| code | name | price |\n| --- | --- | --- |\n| sh688981 | 中芯国际 | 100 |';
assert.throws(()=>verifyQuoteIdentity(raw,'长鑫科技',['quote','sh688981']),/主体不匹配/);
assert.throws(()=>verifyQuoteIdentity(raw,'中芯国际',['quote','sh688825']),/代码与请求/);
assert.throws(()=>verifyQuoteIdentity(raw,'',['quote','sh688981']),/必须提供/);
assert.throws(()=>verifyQuoteIdentity('empty','中芯国际',['quote','sh688981']),/缺少/);
assert.throws(()=>verifyQuoteIdentity(raw,'中芯国际',['quote','sh688981,sh688825']),/逐个/);
assert.equal(verifyQuoteIdentity(raw,'中芯国际',['quote','688981.SH']).verified,true);
const tool=createWestockTool({workspace:'/tmp',bin:'/bin/echo'});
const missing=await tool.execute('id',{args:['quote','sh688981']});assert.equal(missing.isError,true);
console.log('PASS 7 identity mismatch/missing/batch/correct-name regressions');

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'westock-identity-'));
try {
 const bin=path.join(dir,'westock-fixture');
 fs.writeFileSync(bin,'#!/usr/bin/env node\nprocess.stdout.write('+JSON.stringify(raw)+');\n');fs.chmodSync(bin,0o755);
 const fixture=createWestockTool({workspace:dir,bin});
 const mismatch=await fixture.execute('bad',{args:['quote','sh688981'],expectedName:'长鑫科技'});
 assert.equal(mismatch.isError,true);assert.doesNotMatch(mismatch.content[0].text,/\| price \||\| 100 \|/);
 const verified=await fixture.execute('ok',{args:['quote','sh688981'],expectedName:'中芯国际'});
 assert.equal(verified.details.identity.verified,true);assert.equal(verified.details.quotes[0].price,100);assert.match(verified.content[0].text,/\| 100 \|/);
 fs.writeFileSync(bin,'#!/usr/bin/env node\nprocess.stdout.write('+JSON.stringify('| 证券代码 | 证券简称 | 最新价 |\n| --- | --- | --- |\n| sh688981 | 中芯国际 | 100 |')+');\n');
 const cn=await fixture.execute('cn',{args:['quote','sh688981'],expectedName:'中芯国际'});
 assert.equal(cn.details.identity.verified,true);assert.equal(cn.details.quotes[0].price,100);
 fs.writeFileSync(bin,'#!/usr/bin/env node\nprocess.stdout.write('+JSON.stringify(raw)+');process.exitCode=1;\n');
 const error=await fixture.execute('failed',{args:['quote','sh688981'],expectedName:'中芯国际'});
 assert.equal(error.isError,true);assert.deepEqual(error.details.quotes,[]);assert.doesNotMatch(error.content[0].text,/\| 100 \|/);
 console.log('PASS quote execution: mismatched response suppressed; verified price returned');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
