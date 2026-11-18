import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const repo = path.resolve(process.argv[2] || process.cwd());
const load = file => import(pathToFileURL(path.join(repo, file)));
const piRoot = path.join('node_modules','@earendil-works','pi-coding-agent');
const piManifest = JSON.parse(fs.readFileSync(path.join(repo,piRoot,'package.json'),'utf8'));
const { SessionManager } = await load(path.join(piRoot,piManifest.main));
const { Store } = await load('store.mjs');
const { WorkbookStore } = await load('lib/workbook-store.mjs');
const { createWorkbookTool } = await load('lib/workbook-tool.mjs');
const { createTranscriptSearchTool } = await load('lib/transcript-search-tool.mjs');
const { runWithPostAnswer } = await load('server/agent/post-answer.mjs');
const { snapshotMessages, transcriptMessages } = await load('server/agent/snapshot.mjs');
const { attachSessionEvents } = await load('server/agent/event-bridge.mjs');
const { systemHint } = await load('server/project-context.mjs');
const deliveryUI = await load('ui/chat/turn-delivery.js');
globalThis.document = { querySelector: () => null };
globalThis.window = {};
const { messageHTML } = await load('ui/chat/renderer.js');
const bootstrap = fs.readFileSync(path.join(repo,'ui/bootstrap.js'), 'utf8');
const handler = bootstrap.slice(bootstrap.indexOf('function handleServerEvent('), bootstrap.indexOf('async function refreshSnapshot('));
const silent = () => {};
function page() {
  const state = {messages: [], live: {text: '', tools: []}, streaming: false};
  const receive = vm.runInNewContext(handler + '\nhandleServerEvent', {
    ...deliveryUI, state, runtime: {}, window: {},
    renderThread:silent,syncStop:silent,scheduleThread:silent,renderSessions:silent,
    renderAllChrome:silent,scheduleSnapshotPoll:silent,updateSessionItem:silent,
  });
  return {state,receive};
}

const source = '利润模型.xlsx';
const actual = 'PL!B8';
const forecast = 'PL!C8';
const cite = coord => '[' + source + ']' + coord;
const direct = '2025 年实际毛利率为 84.16%，见 ' + cite(actual) + '。';
const earlier = '毛利率为 80%，见 ' + cite(forecast) + '。';
const review = '我上一轮给出的毛利率 80% 有误。原因是把预测列当成了实际列，预测值见 ' + cite(forecast) + '。\n\n修正后的完整回答\n' + direct;
const literal = '上一轮是会议纪要中的栏目名。\n\n修正后的完整回答\n这也是原文的小标题，须逐字保留。';
const draft = '后台审稿草稿：毛利率的出处为 [利润模型.xlsx]PL!Z99。';
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'pe-accept14-'));
const workspace = path.join(dir,'project');
const dataDir = path.join(dir,'data');
fs.mkdirSync(path.join(workspace,'uploads'), {recursive:true});
fs.mkdirSync(path.join(dataDir,'blobs'), {recursive:true});
const db = new DatabaseSync(path.join(dataDir,'workbench.db'));
const store = new Store(db, {workspace, dataDir});
store.migrate();
process.env.PYTHONDONTWRITEBYTECODE = '1';
let ok = 0;
let bad = 0;
function check(label, fn) {
  try { fn(); ++ok; console.log('PASS', label); }
  catch (e) { ++bad; console.error('FAIL', label, e.message); }
}
try {
  execFileSync(process.env.PYTHON_BIN || 'python3', ['-c', [
    'import sys,openpyxl',
    'w=openpyxl.Workbook(); s=w.active; s.title="PL"',
    's["A1"]="指标"; s["B1"]="2025A"; s["C1"]="2025E"',
    's["A8"]="毛利率 (%)"; s["B8"]=84.16; s["C8"]=80',
    's["A10"]="校验"; s["B10"]="=B8+C8"',
    'w.save(sys.argv[1])',
  ].join('\n'),path.join(workspace,'uploads',source)]);
  const material = store.indexFile('uploads/'+source,{kind:'input',source:'upload',author:'acceptance',status:'synced'});
  const workbook = createWorkbookTool({store, workbooks: new WorkbookStore({store}), workspace});
  const ctx = {root:workspace,name:'毛利率验收',store};
  const readArgs = loc => ({path:'uploads/'+source, query:loc, maxCells:1});
  const evidence = { [actual]: 84.16, [forecast]: 80 };
  for (const [loc, value] of Object.entries(evidence)) {
    const res = await workbook.execute('reference-'+loc, readArgs(loc));
    check('真实 XLSX 直接查询 '+loc, () => {
      assert.ok(!res.isError, res.content[0].text);
      assert.ok(res.details.citations.some(c=>c.locator===loc && c.materialId===material.id && c.version===1 && c.value===value));
    });
  }

  function historyTool(session, before) {
    return createTranscriptSearchTool({getMessages:()=>transcriptMessages(session,ctx,{beforeTurnId:before?.()})});
  }
  function scenario() {
    const manager = SessionManager.create(workspace,dir);
    const sessionId = manager.getSessionId();
    const statePage = page(), events = [], internal = [], listeners = new Set();
    let script = [], calls = 0;
    function emit(e) { for (const cb of listeners) cb(e); }
    const messages = [];
    function append(message) {
      message.timestamp = Date.now();
      messages.push(message); manager.appendMessage(message); emit({type:'message_end',message});
    }
    async function attempt() {
      const step = script.shift();
      if (!step) throw Error('意外的额外模型尝试');
      calls++;
      emit({type:'agent_start'});
      for (const [tool, args] of step.tools || []) {
        const toolCallId = 'test-tool-'+(++toolSerial);
        append({role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',id:toolCallId,name:tool.name,arguments:args}]});
        emit({type:'tool_execution_start',toolCallId,toolName:tool.name,args});
        const output = await tool.execute(toolCallId,args);
        assert.ok(!output.isError, JSON.stringify(output.content));
        if (tool.name==='transcript_search') assert.ok(output.details.matches.some(m=>m.role==='assistant' && m.excerpt.includes('80%')), 'review did not find previously delivered 80%');
        const result = {role:'toolResult',toolName:tool.name,toolCallId,...output,isError:Boolean(output.isError)};
        append(result); emit({type:'tool_execution_end',toolCallId,toolName:tool.name,result,isError:result.isError});
      }
      emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:step.text}});
      if (step.text===draft) {
        check('后台草稿生成时实时正文仍为空',()=>{
          assert.equal(statePage.state.live.text,'');
          assert.ok(statePage.state.messages.every(m=>!m.text?.includes('后台审稿草稿')));
          assert.ok(events.every(e=>!JSON.stringify(e).includes('后台审稿草稿')));
        });
      }
      append({role:'assistant',stopReason:'stop',content:[{type:'text',text:step.text}]});
      emit({type:'agent_settled',aborted:false});
    }
    const session = {
      sessionId,sessionManager:manager,messages,
      subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
      async prompt(text){append({role:'user',content:text});await attempt();},
      async sendCustomMessage(m,opt){
        internal.push(m);
        messages.push({role:'custom',...m});
        manager.appendCustomMessageEntry(m.customType,m.content,m.display,m.details);
        if(opt.triggerTurn) await attempt();
      },
    };
    const entry = {id:sessionId,ctx,session,toolArgs:new Map()};
    const publish = ev => { events.push(ev);statePage.receive(ev); };
    attachSessionEvents(entry,{bus:{broadcast:(_entry,ev)=>publish(ev)}});
    return {
      entry,events,internal,history:historyTool(session,()=>entry.activeTurn?.turnId),
      async run(question, steps, options={}) {
        script = [...steps];
        const before = calls;
        const record = await runWithPostAnswer(entry,question,options,publish);
        const live = statePage.state.messages.find(m=>m.role==='assistant' && m.turnId===record.turnId);
        const reopened = {sessionId,sessionManager:SessionManager.open(manager.getSessionFile()),messages:[]};
        const durable = reopened.sessionManager.getBranch().filter(e=>e.customType==='pe_turn_delivery' && e.data.turnId===record.turnId);
        const snap = snapshotMessages(reopened,ctx,{id:sessionId});
        const fresh = page();
        fresh.receive({type:'snapshot',messages:snap,sessionId});
        const refreshed = fresh.state.messages.find(m=>m.role==='assistant' && m.turnId===record.turnId);
        const transcript = transcriptMessages(reopened,ctx).filter(m=>m.role==='assistant').at(-1);
        return {record,live,refreshed,transcript,reopened,durable,n:calls-before,remaining:script.length};
      },
    };
  }
  let toolSerial = 0;
  const oldPrompt = /最后一次工具调用之?后(?:的文字|才)|最后一次工具调用之后/;
  const hint = systemHint(ctx,{workbookQuery:true});
  check('系统提示移除最后一次工具调用裁决正文的要求',()=>assert.doesNotMatch(hint.match(/.{0,20}最后一次工具调用.{0,50}/)?.[0] || '',oldPrompt));
  const skill = fs.readFileSync(path.join(repo,'skills/model-qa/SKILL.md'),'utf8');
  check('投研规则保留期间、预测与实际的判断且允许更正追溯旧值',()=>{
    assert.match(skill,/期间/); assert.match(skill,/预测/); assert.match(skill,/实际|兑现/);
    assert.ok(!/更正[：:]使用台账当前值，不复述已被替代的数值/.test(skill),'方法无条件禁止主动更正时复述旧值');
  });

  async function validate(label,result,expected,locs,terms) {
    const {record,live,refreshed,transcript,durable,reopened} = result;
    check(label+' / 决策已持久化且仅提交一次',()=>{
      assert.equal(record.status,'completed',record.reason);
      assert.equal(result.remaining,0);
      assert.deepEqual(durable.map(e=>e.data),[record]);
    });
    for (const [channel, value] of [['提交',record?.text],['实时正文',live?.text],['刷新',refreshed?.text],['历史',transcript?.content]]) {
      check(label+' / '+channel, ()=>assert.equal(value,expected));
    }
    for (const [surface, row] of [['实时渲染',live],['刷新渲染',refreshed]]) {
      check(label+' / '+surface,()=>{
        const html=messageHTML(row);
        for (const term of terms) assert.ok(html.includes(term),'呈现缺失 '+term);
        for (const loc of locs) {
          assert.ok(row.citations.some(c=>c.locator===loc && c.materialId===material.id && c.version===1 && c.value===evidence[loc]),'引用丢失 '+loc);
          assert.ok(html.includes('data-locator="'+loc+'"'),'不可点击 '+loc);
        }
        if (locs.length) assert.ok(row.tools.some(t=>t.name==='workbook_query' && t.status==='done'), '查表步骤不可见');
        assert.doesNotMatch(html,/后台审稿草稿/);
      });
    }
    const query = terms[0];
    const lookup = await historyTool(reopened).execute('next-search',{query,limit:50});
    check(label+' / 下一轮 transcript_search',()=>{
      assert.ok(lookup.details.matches.some(m=>m.role==='assistant' && m.excerpt.includes(query) && locs.every(loc=>(m.citations||[]).some(c=>c.locator===loc))),'检索未返回正式正文和对应出处');
      assert.ok(transcript?.content && !transcript.content.includes('后台审稿草稿'));
    });
  }
  const runA = scenario();
  await validate('普通问答', await runA.run('2025 年实际毛利率是多少？', [{tools:[[workbook,readArgs(actual)]],text:direct}]),direct,[actual],['84.16%','2025 年实际毛利率']);

  const runB = scenario();
  const passB = await runB.run('请给出 2025 年实际毛利率和出处。', [
    {text:draft}, {tools:[[workbook,readArgs(actual)]],text:direct}
  ]);
  check('后台缺证确实触发一次纠错且工具步骤可见',()=>{
    assert.equal(passB.n,2);
    assert.equal(runB.internal.filter(m=>m.customType==='pe_answer_correct').length,1);
    assert.equal(runB.events.filter(e=>e.type==='tool.completed' && e.name==='workbook_query').length,1);
    assert.equal(runB.events.filter(e=>e.type==='turn.delivered').length,1);
  });
  check('内部纠错提示移除最后一次工具调用裁决正文的要求',()=>{
    const correction=runB.internal.find(m=>m.customType==='pe_answer_correct');
    assert.ok(correction); assert.doesNotMatch(correction.content.match(/.{0,20}最后一次工具调用.{0,50}/)?.[0]||'',oldPrompt);
  });
  await validate('后台补证',passB,direct,[actual],['84.16%','2025 年实际毛利率']);
  const hidden = await historyTool(passB.reopened).execute('hidden',{query:'后台审稿草稿'});
  check('下轮无法检索后台草稿',()=>assert.equal(hidden.details.totalMatches,0));
  const runC=scenario();
  const prior=await runC.run('模型里毛利率是多少？',[{tools:[[workbook,readArgs(forecast)]],text:earlier}]);
  check('用户复核前已正式交付旧值',()=>assert.equal(prior.live?.text,earlier));
  const passC=await runC.run('请复核你上一轮给出的毛利率，我要实际值。如有误请更正，解释差异并标明新出处。',[
    {tools:[[runC.history,{query:'80%'}],[workbook,readArgs(forecast)],[workbook,readArgs(actual)]],text:review},
  ]);
  check('主动复核注入回合的规则允许对照已发布旧值',()=>{
    const injected=runC.internal.filter(m=>m.customType==='pe_turn_context').at(-1);
    assert.ok(injected);assert.ok(!/遵循台账更正，不得复述已被替代的数值/.test(injected.content),'实发提示禁止复述旧值');
  });
  await validate('主动复核',passC,review,[actual,forecast],['原因是把预测列当成了实际列','80%','84.16%','修正后的完整回答']);
  const runQuoted=scenario();
  await runQuoted.run('先给出模型毛利率。',[{tools:[[workbook,readArgs(forecast)]],text:earlier}]);
  const exact = '我上一轮给出的毛利率 80% 有误。\n\n修正后的完整回答\n毛利率为 84.16%，见 PL!B8。';
  const passQuoted=await runQuoted.run('请复核上一轮的毛利率并给出更正。',[
    {tools:[[runQuoted.history,{query:'80%'}],[workbook,readArgs(actual)]],text:exact},
  ]);
  await validate('原样复现（旧值来自前文）',passQuoted,exact,[actual],['我上一轮给出的毛利率 80% 有误','修正后的完整回答','84.16%']);

  const runD=scenario();
  await validate('合法标题',await runD.run('请逐字引用两个栏目标题和备注。',[{text:literal}]),literal,[],['上一轮是会议纪要中的栏目名','修正后的完整回答']);

  const legacyManager=SessionManager.create(workspace,dir);
  const legacyUser = text=>legacyManager.appendMessage({role:'user',content:text,timestamp:1});
  const legacyReply = text=>legacyManager.appendMessage({role:'assistant',content:[{type:'text',text}],stopReason:'stop',timestamp:2});
  legacyUser('早期会话的栏目是什么？'); legacyReply('上一轮讨论的是预测口径。');
  legacyUser('早期会话的实际值是多少？'); legacyReply(draft);
  legacyManager.appendCustomMessageEntry('pe_answer_correct','补证重写',false,{});
  legacyReply('我上一轮把毛利率说错了，这不准确。\n\n修正后的完整回答\n'+direct);
  const oldSession={sessionManager:SessionManager.open(legacyManager.getSessionFile())};
  const old=snapshotMessages(oldSession,ctx).filter(m=>m.role==='assistant');
  const oldHistory=transcriptMessages(oldSession,ctx).filter(m=>m.role==='assistant');
  check('旧 JSONL 可刷新、检索，旧后台修订保留最终结论',()=>{
    assert.equal(old.length,2);assert.equal(oldHistory.length,2);
    assert.equal(old[0].text,'上一轮讨论的是预测口径。');assert.equal(oldHistory[0].content,old[0].text);
    assert.ok(old[1].text.includes(direct));assert.doesNotMatch(old[1].text,/后台审稿草稿/);
    assert.equal(oldHistory[1].content,old[1].text); assert.ok(messageHTML(old[1]).includes('84.16%'));
  });
} finally {
  db.close();
  fs.rmSync(dir,{recursive:true,force:true});
}
console.log('checks:',ok,'passed,',bad,'failed; provider output is deterministic; XLSX, tools, Pi JSONL, server and UI delivery paths run locally.');
if (bad) process.exitCode=1;
