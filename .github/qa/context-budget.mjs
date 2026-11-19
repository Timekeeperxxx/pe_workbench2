import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';

const repo=process.cwd();
const file = p=>pathToFileURL(path.resolve(repo,p)).href;
const { estimateTokens } = await import(file('node_modules/@earendil-works/pi-coding-agent/dist/index.js'));
const { createAssistantMessageEventStream } = await import(file('node_modules/@earendil-works/pi-ai/dist/index.js'));
let captured;
// End the captured request with a recognizable SDK error, before any network I/O
// or answer-audit requests. The research guard consumes this stream asynchronously.
const captureMarker = 'fixture captured projected model request';
globalThis.__budgetFixtureTransport = (model, ctx) => {
  captured = ctx.messages;
  const stream = createAssistantMessageEventStream();
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const error = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: 'error', errorMessage: captureMarker, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zeroCost },
  };
  stream.push({ type: 'error', reason: 'error', error });
  stream.end();
  return stream;
};
registerHooks({load(url, context, next){
  const result=next(url,context);
  if (url!==file('server/agent/session-service.mjs')) return result;
  const src=readFileSync(fileURLToPath(url),'utf8');
  const start='session = created.session;';
  assert(src.includes(start));
  return {...result,source:src.replace(start,start+'\n      session.agent.streamFunction = globalThis.__budgetFixtureTransport;')};
}});
const {loadConfig}=await import(file('server/config.mjs'));
const {createWorkbench}=await import(file('server/create-app.mjs'));
const root=await mkdtemp(path.join(tmpdir(),'pe11-runtime-'));
const model={id:'fixture',api:'fixture',provider:'fixture',contextWindow:5000,maxTokens:1000};
const tokens=msgs=>msgs.reduce((sum,m)=>sum+estimateTokens(m),0)+model.maxTokens;
const ask={role:'user',content:'2024 年营业利润是多少？请给我来源、搜索过的范围和缺口。',timestamp:1};
const needle='827.35';
const locator='Profit!D42';
const lookup='FY2024';
function pair(i,name,data,isError){
 const args={query:'营业利润 FY2024'};
 return [
 {role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',id:'call'+i,name,arguments:args}],timestamp:2+i*2},
 {role:'toolResult',toolName:name,toolCallId:'call'+i,isError,content:[{type:'text',text:JSON.stringify(data)}],timestamp:3+i*2}
 ];
}
const fail=()=>({error:'SOURCE_TIMEOUT',retry:'try again',context:'x'.repeat(4900)});
const val={value:827.35,display_unit:'万元',period:lookup,materialId:'M7',version:3,locator};
const success=pad=>({unusedNotes:'x'.repeat(pad),cells:[val]});
const many=[ask,...pair(1,'workbook_query',fail(),true),...pair(2,'workbook_query',fail(),true),...pair(3,'workbook_query',success(8800),false),...pair(4,'source_search',{hits:[],coverage:'SEC_FILINGS_2024',detail:'x'.repeat(4300)},false),...pair(5,'remote_lookup',{code:'UNAVAILABLE_FX',retry:'after 60s',detail:'x'.repeat(4500)},true)];
const long=[ask,...pair(1,'workbook_query',success(36000),false)];
const output={};
let app;
try{
 process.env.DEEPSEEK_API_KEY='synthetic-no-network';
 const config=await loadConfig({root,env:{ASR:'0',WATCH_SCHEDULER:'0',TRACKING_SCHEDULER:'0',MONITOR_SCHEDULER:'0',SOURCE_SCHEDULER:'0'}});
 app=await createWorkbench({config,logger:{log(){},warn(){},error(){}}});
 const request=Readable.from(['{}']);request.method='POST';request.headers={};
 const res=new EventEmitter();let data='';res.writeHead=()=>{};res.write=c=>{data+=c};res.end=c=>{if(c)data+=c};
 await app.handleApi(request,res,new URL('http://test/api/sessions'));
 const session=app.live.get(JSON.parse(data).id).session;
 for(const [name,msgs] of [['aggregate',many],['longSuccess',long]]){
  const frozen=JSON.stringify(msgs);
  for(const item of msgs) session.sessionManager.appendMessage(item);
  const sessionFile=session.sessionManager.getSessionFile();
  const before=readFileSync(sessionFile);
  captured=undefined;
  const stream = await session.agent.streamFunction(model, { messages: msgs }, {});
  const response = await stream.result();
  assert.equal(response.errorMessage, captureMarker, 'the capture transport must terminate the request');
  assert.equal(JSON.stringify(msgs),frozen); assert(before.equals(readFileSync(sessionFile)));
  const text=captured?.filter(m=>m.role==='toolResult').flatMap(m=>m.content.map(x=>x.text)).join('\n')||'';
  const used=captured?tokens(captured):null;
  const calls=captured?.flatMap(m=>m.role==='assistant'?m.content.map(x=>x.id):[]);
  const responses=captured?.filter(m=>m.role==='toolResult').map(m=>m.toolCallId);
  const key=text.includes(needle)&&text.includes(locator)&&text.includes('M7')&&text.includes('万元')&&text.includes(lookup);
  output[name]={largestInput:Math.max(...msgs.filter(m=>m.role==='toolResult').map(m=>m.content[0].text.length)),requestedBefore:tokens(msgs),requestedAfter:used,window:model.contextWindow,providerCalled:!!captured,key,canReread:text.includes(locator)&&text.includes('M7'),pairing:!!calls&&JSON.stringify(calls)===JSON.stringify(responses),storageUnchanged:true,...name==='aggregate'?{coverage:text.includes('SEC_FILINGS_2024'),unresolvedError:text.includes('UNAVAILABLE_FX')}:{}};
 }
 console.log(JSON.stringify(output));
 for (const sample of Object.values(output)) {
   assert.ok(sample.providerCalled && sample.requestedAfter <= sample.window, 'model request must fit its window');
   assert.ok(sample.key || sample.canReread, 'evidence or a precise source locator must be available');
   assert.ok(sample.pairing && sample.storageUnchanged, 'call pairing and on-disk transcript must survive projection');
 }
 assert.ok(output.aggregate.coverage && output.aggregate.unresolvedError, 'coverage and unresolved failures must remain visible');
}finally{await app?.close();await rm(root,{recursive:true,force:true})}
