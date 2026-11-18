import assert from 'node:assert/strict';
import {searchTranscript, createTranscriptSearchTool} from '../lib/transcript-search-tool.mjs';
const messages=[
 {role:'custom',customType:'pe_turn_context',content:'7.3'},
 {role:'user',content:'利润 7.3 亿',timestamp:1},
 {role:'assistant',content:[{type:'text',text:'工具前噪音 7.3'},{type:'toolCall',name:'read'}],stopReason:'toolUse'},
 {role:'toolResult',content:'7.3'},
 {role:'assistant',content:'利润为 7.3 亿。',stopReason:'stop',timestamp:2},
 {role:'user',peInternal:true,content:'7.3'},
 {role:'user',content:'更正为72.93亿',timestamp:3},
 {role:'assistant',content:'利润现值72.93亿。',stopReason:'stop',timestamp:4},
];
let r=searchTranscript(messages,{query:'利润 7.3',limit:1});
assert.equal(r.totalMatches,2); assert.equal(r.matches.length,1); assert.equal(r.matches[0].turn,1); assert.ok(r.matches[0].excerpt.includes('**7.3**')); assert.equal(r.coverage.turnsScanned,2);
assert.equal(searchTranscript(messages,{query:'7.3',turn:2}).totalMatches,0);
assert.equal(searchTranscript(messages,{query:'72.93',turnRange:[2,2]}).totalMatches,2);
assert.equal(searchTranscript(messages,{query:'工具前噪音'}).totalMatches,0);
assert.equal(searchTranscript(messages,{query:''}).totalMatches,0);
const tool=createTranscriptSearchTool({getMessages:()=>messages});
assert.equal((await tool.execute('x',{query:'7.3'})).details.totalMatches,2);
console.log('transcript search PASS');

{
  const { transcriptMessages } = await import('../server/agent/snapshot.mjs');
  const message = (role, content, options = {}) => ({type:'message', message:{role, content, ...options}});
  const custom = (customType, data) => ({type:'custom', customType, data});
  const start = (turnId, question) => custom('pe_turn_started', {turnId, question, startedAt:1});
  const delivery = (turnId, text) => custom('pe_turn_delivery', {turnId, text, citations:[], status:'completed', finishedAt:2});
  const branch = [
    message('user','旧会话'),
    message('assistant','隐藏的旧纠错草稿。',{stopReason:'stop'}),
    {type:'custom_message', customType:'pe_answer_correct', content:'内部纠错指令', display:false},
    message('assistant','可检索的旧答案。',{stopReason:'stop'}),
    start('rewrite', '已回答问题'), message('user','已回答问题'),
    message('assistant','原始错误的 A。',{stopReason:'stop'}),
    message('assistant','B。',{stopReason:'stop'}),
    delivery('rewrite','可检索的 B。'),
    start('split','续写问题'), message('user','续写问题'),
    message('assistant','这是前半段，',{stopReason:'length'}), message('assistant','这是后半段。',{stopReason:'stop'}),
    delivery('split','这是前半段，这是后半段。'),
    start('active','本次查询'), message('user','本次查询'),
    message('assistant','本次待核验的中间答案。',{stopReason:'stop'}),
  ];
  const session = {sessionManager:{getBranch:()=>branch}, messages:[]};
  const tool = createTranscriptSearchTool({getMessages:() => transcriptMessages(session)});
  const find = async query => (await tool.execute('search', {query})).details;
  assert.equal((await find('可检索的旧答案')).matches[0].turn, 1);
  assert.equal((await find('可检索的 B')).matches[0].turn, 2);
  assert.equal((await find('这是前半段，这是后半段。')).matches[0].turn, 3);
  for (const query of ['旧纠错草稿', '原始错误', '内部纠错指令', '本次查询', '待核验']) {
    assert.equal((await find(query)).totalMatches, 0);
  }
  assert.equal((await find('可检索')).coverage.totalTurns, 3);
  console.log('history searches the same delivered answers as snapshots passed');
}

{
  const { transcriptMessages } = await import('../server/agent/snapshot.mjs');
  const session = { messages: [
    { role: 'user', content: '旧问题' },
    { role: 'assistant', stopReason: 'toolUse', content: [
      { type: 'text', text: '工具前的准备过程。' }, { type: 'toolCall', name: 'read' },
    ] },
    { role: 'toolResult', isError: true },
    { role: 'assistant', stopReason: 'error', content: '失败片段。' },
  ] };
  for (const query of ['准备过程', '失败片段']) {
    assert.equal(searchTranscript(transcriptMessages(session), { query }).totalMatches, 0);
  }
}

{
  const citations = Array.from({ length: 25 }, (_, i) => ({
    id: `cite-${i}`, locator: `PL!A${i + 1}`, formula: 'A'.repeat(500),
  }));
  const tool = createTranscriptSearchTool({ getMessages: () => [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '可检索的正文。', citations },
  ] });
  const result = await tool.execute('search', { query: '正文', limit: 1 });
  assert.equal(JSON.parse(result.content[0].text).matches[0].excerpt, '可检索的**正文**。');
  assert.ok(result.content[0].text.length <= 12000);
  assert.deepEqual(result.details.matches[0].citations, citations);
}
