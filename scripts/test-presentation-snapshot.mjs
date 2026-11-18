import assert from 'node:assert/strict';
import { snapshotMessages } from '../server/agent/snapshot.mjs';
import { presentUserAnswer } from '../ui/chat/user-facing-answer.js';
import { generateUnifiedPatch } from '@earendil-works/pi-coding-agent';
const a={presentation:{verdict:{text:'旧判断'}}};
const b={presentation:{verdict:{text:'新判断'}}};
const call=(id,state)=>({role:'assistant',content:[{type:'toolCall',id,name:'write',arguments:{path:'exports/analysis-state.json',content:JSON.stringify(state)}}]});
const result=(id,isError=false)=>({role:'toolResult',toolCallId:id,isError});
const user={role:'user',content:'分析'};
const ctx={root:'/tmp/project'};
const session={messages:[user,call('1',a),result('1'),{role:'assistant',content:[{type:'text',text:'回答'}]},user,call('2',b),result('2')]};
let messages=snapshotMessages(session,ctx).filter(x=>x.role==='assistant');
assert.deepEqual(messages[0].analysisState,a); assert.deepEqual(messages[1].analysisState,b);
session.messages.push(user,call('3',a),result('3',true));
messages=snapshotMessages(session,ctx).filter(x=>x.role==='assistant'); assert.equal(messages[2].analysisState,undefined);
session.messages.push(user,{role:'assistant',content:[{type:'toolCall',id:'4',name:'edit',arguments:{path:'exports/analysis-state.json',oldText:'新判断',newText:'更新判断'}}]},result('4'));
messages=snapshotMessages(session,ctx).filter(x=>x.role==='assistant'); assert.equal(messages[3].analysisState.presentation.verdict.text,'更新判断');
const existing={messages:[user,{role:'assistant',content:[{type:'toolCall',id:'r1',name:'read',arguments:{path:'exports/analysis-state.json'}}]},{role:'toolResult',toolCallId:'r1',content:[{type:'text',text:JSON.stringify(a)}]},{role:'assistant',content:[{type:'toolCall',id:'e1',name:'edit',arguments:{path:'exports/analysis-state.json',oldText:'旧判断',newText:'新会话更新'}}]},result('e1')]};
assert.equal(snapshotMessages(existing,ctx)[1].analysisState?.presentation.verdict.text,'新会话更新');
console.log('presentation snapshot passed');

{
  const before = { presentation: { verdict: { text: "初始判断", status: "先前状态" } } };
  const after = { presentation: { verdict: { text: "采用先前状态检验", status: "更新状态" } } };
  const path = "exports/analysis-state.json";
  const json = value => JSON.stringify(value);
  const edit = { role: "assistant", content: [{ type: "toolCall", id: "patch", name: "edit", arguments: { path, edits: [
    { oldText: "初始判断", newText: "采用先前状态检验" },
    { oldText: "先前状态", newText: "更新状态" },
  ] } }] };
  const edited = { ...result("patch"), details: { patch: generateUnifiedPatch(path, json(before), json(after)) } };
  const session = { messages: [user, call("initial", before), result("initial"), user, edit, edited] };
  // The tool resolves both replacements against the original text.
  assert.deepEqual(snapshotMessages(session, ctx).filter(m => m.role === "assistant")[1].analysisState, after);
}

const timedSession={messages:[
  {...user,timestamp:'2026-11-03T02:05:00Z'},
  {...call('timed',a),timestamp:'2026-11-03T02:06:00Z'},result('timed'),
  {role:'assistant',timestamp:'2026-11-03T02:10:00Z',content:'回答'},
]};
assert.equal(snapshotMessages(timedSession,ctx)[1].turnStartedAt,'2026-11-03T02:05:00Z');

{
  const base = {presentation:{verdict:{id:'verdict',text:'旧判断',status:'条件判断',value_identity:'自建情景'}}};
  const editsSession = {messages:[
    user,
    {role:'assistant',content:[{type:'toolCall',id:'ra',name:'read',arguments:{path:'exports/analysis-state.json'}}]},
    {role:'toolResult',toolCallId:'ra',content:[{type:'text',text:JSON.stringify(base)}]},
    {role:'assistant',content:[{type:'toolCall',id:'ea',name:'edit',arguments:{path:'exports/analysis-state.json',edits:[{oldText:'"text":"旧判断"',newText:'"text":"批量编辑判断"'}]}}]},
    result('ea'),
    {role:'assistant',content:[{type:'text',text:'交付'}]},
  ]};
  const msg = snapshotMessages(editsSession,ctx).filter(x=>x.role==='assistant').at(-1);
  assert.equal(msg.analysisState?.presentation.verdict.text,'批量编辑判断');
  console.log('edits array snapshot passed');
}

{
  const repair = [
    '核验结果（全部为工作簿缓存值，以 Excel 重算为准）',
    '结论：22 个待核数字中有 19 个核对成功。我上一轮把它们当作模型直接显示值，这不准确。下面逐项给出出处，再给修正后的完整回答。',
    '一、逐个数字的出处核验',
    '5.58% 来自 PL。',
    '二、修正后的完整回答（事实／假设／推断三分）',
    '事实：2026E 毛利率 84.16%，是损益表缓存值。',
  ].join('\n\n');
  assert.equal(presentUserAnswer(repair), '事实：2026E 毛利率 84.16%，是损益表缓存值。');
  assert.equal(presentUserAnswer(presentUserAnswer(repair)), presentUserAnswer(repair));
  assert.equal(presentUserAnswer('上一轮讨论的目标价是 129 元。缓存值以 Excel 重算为准。'), '上一轮讨论的目标价是 129 元。缓存值以 Excel 重算为准。');
  assert.equal(presentUserAnswer('我上一轮把毛利率说成直接显示值，这不准确。2026E 毛利率是 84.16%。'), '2026E 毛利率是 84.16%。');
  const session = { messages: [
    { role: 'user', content: '毛利率呢' },
    { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: repair }] },
  ] };
  const shown = snapshotMessages(session, ctx).find(item => item.role === 'assistant');
  assert.equal(shown.text, '事实：2026E 毛利率 84.16%，是损益表缓存值。');
  assert.equal(shown.text.includes('我上一轮'), false);
  assert.equal(shown.text.includes('不准确'), false);
  console.log('repair narration hidden from the answer passed');
}

{
  const citeA = { id: 'a', materialId: 'model', version: 1, locator: 'Model!A1' };
  const citeB = { id: 'b', materialId: 'model', version: 1, locator: 'Model!B2' };
  const msg = (role, content, extras = {}) => ({ type: 'message', message: { role, content, ...extras } });
  const custom = (customType, data) => ({ type: 'custom', customType, data });
  const start = (turnId, question) => custom('pe_turn_started', { turnId, question, startedAt: 1 });
  const done = (turnId, text, citations, status = 'completed', reason) =>
    custom('pe_turn_delivery', { turnId, text, citations, status, finishedAt: 2, reason });
  const managed = [
    msg('user', '旧问题'),
    msg('assistant', '旧回答 Model!A1。', { stopReason: 'stop' }),
    custom('pe_answer_lint', { citations: [citeA] }),
    start('rewrite', '新问题'),
    msg('user', '新问题'),
    msg('assistant', [{type: 'toolCall', id: 'lookup', name: 'read', arguments: { path: 'sample.xlsx' }}]),
    msg('toolResult', [{type: 'text', text: '工具原始结果'}], {toolCallId: 'lookup'}),
    msg('assistant', '错误的草稿 A。', { stopReason: 'stop' }),
    custom('pe_answer_lint', { turnId: 'rewrite', findings: [{excerpt:'错误的草稿 A。'}], citations: [citeA] }),
  ];
  const session = { sessionManager: {getBranch() { return managed; }}, messages: [] };
  const view = () => snapshotMessages(session, ctx);
  assert.equal(view().length, 4);
  assert.deepEqual(view()[1].citations, [citeA]);
  assert.equal(view()[1].text, '旧回答 Model!A1。');
  assert.equal(view()[2].turnId, 'rewrite');
  assert.equal(view()[3].status, 'pending');
  assert.equal(view()[3].text, '');
  assert.equal(view()[3].tools[0].output, '工具原始结果');
  assert.ok(!JSON.stringify(view()).includes('草稿 A'));
  managed.push(msg('assistant', 'B 原稿', {stopReason: 'stop'}), done('rewrite', '最终 B，见 Model!B2。', [citeB]));
  assert.deepEqual(view()[3].citations, [citeB]);
  assert.equal(view()[3].status, 'completed');
  assert.equal(view()[3].text, '最终 B，见 Model!B2。');
  assert.ok(!JSON.stringify(view()).includes('B 原稿'));

  managed.push(start('split', '续写'), msg('user', '续写'),
    msg('assistant', '这是前半段，', {stopReason: 'length'}), msg('assistant', '这是后半段。', {stopReason: 'stop'}),
    done('split', '这是前半段，这是后半段。', []), done('split', '迟到的重复回放', []));
  const split = view().filter(item => item.turnId === 'split' && item.role === 'assistant');
  assert.equal(split.length, 1);
  assert.equal(split[0].text, '这是前半段，这是后半段。');
  // A failure before Pi adds the real user message still owns a visible pair.
  for (const [status, text, reason] of [
    ['failed', '', '模型请求失败'],
    ['cancelled', '', '已取消'],
    ['partial', '已核验段落。', '余下段落未得到核验'],
  ]) {
    managed.push(start(status, '待处理问题'), done(status, text, [], status, reason));
    const pair = view().filter(item => item.turnId === status);
    assert.equal(pair.length, 2);
    assert.equal(pair[0].text, '待处理问题');
    assert.equal(pair[1].status, status);
    assert.equal(pair[1].text, text);
    assert.equal(pair[1].reason, reason);
  }
  console.log('delivered snapshot, pending tools, legacy citations and terminal states passed');
}
