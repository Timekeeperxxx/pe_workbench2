import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] || process.cwd());
const read = file => import(pathToFileURL(resolve(root, file)));
const { collectCitationsFromToolCalls: collect, rehydrateCitations, citationFromCell } = await read('lib/citations.mjs');
const { lintAnswer, lintLedgerAnswer } = await read('lib/answer-lint.mjs');
const { adoptedCitations, blockingFinding, workbookItemCoverage, answerBlocks } = await read('server/agent/answer-delivery.mjs');
const { checkTurnTools } = await read('lib/turn-context.mjs');
const { indexGraph, queryGraph, formatResult } = await read('lib/workbook-query.mjs');
const { createWorkbookTool } = await read('lib/workbook-tool.mjs');
const { createRatioTool } = await read('lib/calc-tool.mjs');

const material = { id:'earnings', name:'财务模型.xlsx', version:2 };
const cell = (locator, value, metric, unit) => citationFromCell({
  locator, value, metric, period:'2025A', display_unit:unit, unit, currency:'CNY', scope:'合并', basis_type:'实际'
}, material);
const revenue = cell('Model!A1', 100, '收入', '亿元');
const costs = cell('Model!B1', 40, '成本', '亿元');
const toEvent = (id, name, result) => ({ id, name, success:!result.isError, details:result.details, result });
const result = citations => ({details:{citations}});
const success = (...citations) => toEvent('model-read', 'workbook_query', result(citations));
const stale = {...revenue,id:'old-revenue',version:1};
const failed = toEvent('failed-read', 'workbook_query', {isError:true,details:{error:'工作簿读取失败',citations:[costs]}});
const graph = indexGraph({
  sheets:[{name:'Model'}, {name:'Notes'}],
  cells:[['Model!A1',null,100,1,1,'收入','2025A'],['Notes!A1',null,11,1,1,'其他','2025A']], edges:[]
});
const workbook = createWorkbookTool({
  workspace:root,
  store:{findMaterialByPath:()=>({...material,versions:[{v:material.version}]})},
  workbooks:{queryMaterial:async (_id, query, opts)=>{
    const found = queryGraph(graph, query, opts);
    return {...found,text:formatResult(found),path:"fixture.xlsx",sha256:"fixture-identity",version:material.version};
  }}
});
const missResult = await workbook.execute('one-sheet', {path:'fixture.xlsx',query:'完全陌生的字段',sheet:'Model'});
const miss = toEvent('one-sheet','workbook_query',missResult);
const negativeFindings = (text) => checkTurnTools({answer:text,toolCalls:[miss]});
const findings = (answer, toolCalls, currentVersions = {earnings:2}, question = '请核验该数字。') => {
  const citations = rehydrateCitations({answer,thisTurnCitations:collect(toolCalls),currentVersions});
  const context = {question,citations,toolCalls,currentVersions};
  const lint = lintAnswer(answer,context);
  const ledger = lintLedgerAnswer(answer,{facts:[]},{...context,locatorFindings:lint.filter(f=>f.rule==='unverified_locator')});
  return [...lint,...ledger,...checkTurnTools({answer,toolCalls})].filter(blockingFinding);
};
const plain = '2025A 合并收入为 100 亿元，见 Model!A1。';
const labels = list => list.map(f=>f.rule);
function expectBlocked(answer,calls) {
  const blocked = findings(answer,calls);
  assert.ok(blocked.length > 0, 'unsupported assertion produced no blocking finding');
}
let green = 0, red = 0;
async function check(name, test) {
  try { await test(); green++; console.log('PASS', name); }
  catch (e) { red++; console.log('FAIL',name,'|',String(e.message).replace(/\s+/g, ' ').slice(0,310)); }
}
await check('valid same-source/same-identity amount',()=>assert.deepEqual(labels(findings(plain,[success(revenue)])),[]));
await check('failed call carrying real citation',()=>assert.deepEqual(collect([failed]).map(x=>x.locator),[]));
await check('mixed round independently retains only successful result',()=>assert.deepEqual(collect([failed,success(revenue)]).map(x=>x.locator),['Model!A1']));
// No producer in the baseline defines a partial-result wire format. This fixture uses
// the workbook tool's existing cells list as the independently returned rows, plus
// explicit success IDs. The sibling citation has no returned cell or success ID.
const partiallyRead=toEvent('partial-read','workbook_query',{details:{
  status:'partial',partial:true,materialId:material.id,version:material.version,
  cells:[{id:revenue.locator,locator:revenue.locator,value:revenue.value,rowLabel:revenue.metric}],
  successfulCitationIds:[revenue.id],citations:[revenue,costs]
}});
await check('explicit partial result excludes an undeclared item',()=>assert.deepEqual(collect([partiallyRead]).map(x=>x.locator),['Model!A1']));
await check('complete range round-trips both cells',()=>{
  const combined=collect([success(revenue,costs)]);
  assert.deepEqual(adoptedCitations('工作表 Model!A1:B1。',combined).map(c=>c.locator).sort(),['Model!A1','Model!B1']);
});
await check('actual bounded miss coverage returned by workbook tool',()=>{
  assert.deepEqual(miss.details.coverage.sheetsSearched,['Model']);
  assert.equal(miss.details.coverage.complete,false); assert.equal(miss.details.coverage.miss,true);
  assert.deepEqual(collect([miss]),[]);
});
await check('miss supports an explicitly bounded negative',()=>assert.deepEqual(labels(negativeFindings('在 Model 表已查范围内未找到该字段。')),[]));
await check('miss cannot support a whole-workbook absence',()=>assert.ok(negativeFindings('整个工作簿不存在该字段。').length>0,'unbounded negative accepted'));
await check('miss cannot support a concrete number',()=>expectBlocked(plain,[miss]));
await check('2026E claim cannot use a 2025A cell with the same value',()=>expectBlocked(plain.replace('2025A','2026E'),[success(revenue)]));
await check('wrong unit cannot borrow equal value at same coordinate',()=>expectBlocked(plain.replace('100 亿元','100 万元'),[success(revenue)]));
const coincident = cell('Notes!B3',100,'预付款','万元');
await check('unrelated equal value/unit cannot validate the cited cell',()=>expectBlocked(plain.replace('100 亿元','100 万元'),[success(revenue,coincident)]));
await check('wrong metric cannot borrow equal value at same coordinate',()=>expectBlocked(plain.replace('收入','净利润'),[success(revenue)]));
await check('stale current-turn citation cannot establish current amount',()=>expectBlocked(plain,[success(stale)]));
await check('stale ledger entry excluded (control)',()=>assert.deepEqual(rehydrateCitations({register:{facts:[{status:'current',citation:stale}]},answer:plain,currentVersions:{earnings:2}}),[]));
const ratio = await createRatioTool().execute('ratio-1',{numerator:40,denominator:100,op:'%',citations:[costs,revenue]});
const calc = toEvent('ratio-1','ratio',ratio);
await check('valid relationship preserves both original IDs in calculation result',()=>{
  assert.equal(calc.success,true);
  assert.deepEqual(calc.details.citations[0].derivedFrom,[costs.id,revenue.id]);
  assert.equal(Number(calc.details.citations[0].value),40);
});
await check('ratio with both independently checked inputs supports claim',()=>assert.deepEqual(labels(findings('成本占比为 40%，见 Model!B1。',[calc,success(costs,revenue)])),[]));
await check('ratio cannot support claim when one upstream source was never observed',()=>expectBlocked('成本占比为 40%，见 Model!B1。',[calc,success(costs)]));
await check('a trailing caveat on other assumptions cannot waive a wrong period', () =>
  expectBlocked('2026E 收入为 100 亿元（其他假设未核验），见 Model!A1。', [success(revenue)]));
await check('a leading caveat on other assumptions cannot waive an unsupported amount', () =>
  expectBlocked('其他假设未核验，收入为 789 亿元。', [success(revenue)]));
function responseProblems(question, answer) {
  const calls = [success(revenue)];
  const evidence = collect(calls);
  const coverage = workbookItemCoverage(question, answerBlocks(answer), evidence, true);
  return [...findings(answer, calls, {earnings:2}, question), ...coverage.missing, ...coverage.unsupported];
}
await check('an elided single-metric answer inherits the net-income question', () =>
  assert.ok(responseProblems('2025A 净利润是多少？', '为 100 亿元，见 Model!A1。').length));
await check('citing a valid revenue amount cannot answer a net-income-only question', () =>
  assert.ok(responseProblems('净利润是多少？', '收入为 100 亿元，见 Model!A1。').length));
await check('an elided revenue answer with matching evidence passes', () =>
  assert.deepEqual(responseProblems('2025A 营业收入是多少？','为 100 亿元，见 Model!A1。'), []));
console.log('SUMMARY',green,'passed,',red,'failed'); process.exitCode=red?1:0;
