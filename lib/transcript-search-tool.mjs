import {Type} from 'typebox';
import {randomUUID} from 'node:crypto';
import {searchLedger} from './ledger.mjs';
const textOf=c=>typeof c==='string'?c:(Array.isArray(c)?c.filter(b=>b.type==='text').map(b=>b.text||'').join('\n'):'');
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function searchTranscript(messages=[],opts={}) {
  const terms=String(opts.query||'').trim().split(/\s+/).filter(Boolean).slice(0,20);
  const limit=Math.max(1,Math.min(50,Number(opts.limit)||5));
  let turn=0;const rows=[];const scanned=new Set();
  for(const m of messages) {
    if(m.peInternal||m.customType||m.role==='custom') continue;
    if(m.role==='user') turn++;
    if(!['user','assistant'].includes(m.role)||!turn) continue;
    if(m.role==='assistant'&&(m.stopReason&&m.stopReason!=='stop'||Array.isArray(m.content)&&m.content.some(b=>b.type==='toolCall'))) continue;
    if(opts.turn!=null&&turn!==Number(opts.turn)) continue;
    if(opts.turnRange&&(turn<opts.turnRange[0]||turn>opts.turnRange[1])) continue;
    scanned.add(turn);
    const text=textOf(m.content); const lower=text.toLowerCase();
    if(!terms.length||!terms.every(t=>lower.includes(t.toLowerCase()))) continue;
    const pos=Math.min(...terms.map(t=>lower.indexOf(t.toLowerCase())));
    const start=Math.max(0,pos-200), end=Math.min(text.length,pos+Math.max(...terms.map(t=>t.length))+200);
    const excerpt=text.slice(start,end);
    const claims=m.sourceClaims?.filter(c=>c.start<end && c.end>start);
    const cited=claims ? (m.citations??[]).filter(c=>claims.some(claim=>claim.citationIds?.includes(c.id))) : m.citations;
    const re=new RegExp(terms.map(escape).sort((a,b)=>b.length-a.length).join('|'),'gi');
    rows.push({turn,role:m.role,timestamp:m.timestamp??null,excerpt:excerpt.replace(re,m=>`**${m}**`),
      ...(m.role==='assistant' && m.sourceTurnId ? {sourceTurnId:m.sourceTurnId,sourceStatus:m.sourceStatus,sourceLimits:m.sourceLimits??[]} : {}),
      ...(m.legacyAnchor?{legacyAnchor:m.legacyAnchor}:{}),
      ...(m.sourceDigest?{sourceDigest:m.sourceDigest,excerptRange:[start,end],sourceClaims:claims?.map(({relation,start,end,citationIds})=>({relation,start,end,citationIds}))}:{}),
      ...(m.role==='assistant' && cited?.length ? {citations:cited} : {})});
  }
  return {matches:rows.slice(0,limit),totalMatches:rows.length,coverage:{turnsScanned:scanned.size,turns:[...scanned],totalTurns:turn,truncated:rows.length>limit}};
}
export const TRANSCRIPT_SEARCH_CONTEXT_CHARS = 12000;
function modelSearchText(details) {
  // The ledger snapshot and complete cited answers remain in the execution record.
  const {ledger, ...search} = details;
  if (ledger) search.ledgerSummary = {
    sessionId: ledger.sessionId, facts: search.ledgerCoverage.factsScanned,
    corrections: search.ledgerCoverage.correctionsScanned,
  };
  const full = JSON.stringify(search);
  if (full.length <= TRANSCRIPT_SEARCH_CONTEXT_CHARS) return full;
  const {turns, ...counts} = search.coverage;
  const compact = {
    ...search, matches: [], ...(search.sourceEvidence?{sourceEvidence:[]}:{}), coverage: turns.length <= 100 ? search.coverage : {
      ...counts, firstTurn: turns[0], lastTurn: turns.at(-1), turnListOmitted: true,
    }, ...(ledger ? {ledgerMatches: []} : {}), truncated: true,
    ...(search.matches.some(match => match.citations?.length) ? { citationDetailsOmitted: true } : {}),
  };
  for (const row of search.sourceEvidence??[]) {
    compact.sourceEvidence.push(row);
    if (JSON.stringify(compact).length>TRANSCRIPT_SEARCH_CONTEXT_CHARS) {
      compact.sourceEvidence.pop();
      const ref={handle:row.handle,itemIds:row.itemIds,relation:row.relation,turn:row.turn,sourceStatus:row.sourceStatus,fieldsOmitted:true};
      compact.sourceEvidence.push(ref);
      if (JSON.stringify(compact).length>TRANSCRIPT_SEARCH_CONTEXT_CHARS) compact.sourceEvidence.pop();
      compact.sourceEvidenceOmitted=true;
    }
  }
  // Alternate sources so a long transcript hit cannot crowd out a ledger correction.
  const groups = ['matches', 'ledgerMatches'].filter(key => search[key]?.length);
  const citations = [];
  for (let i = 0; i < Math.max(0, ...groups.map(key => search[key].length)); i++) {
    for (const key of groups) {
      if (!search[key][i]) continue;
      const {citations: refs, ...row} = search[key][i];
      if (row.excerpt?.length > 500) row.excerpt = row.excerpt.slice(0, 500) + '…';
      const target = compact[key];
      target.push(row);
      if (JSON.stringify(compact).length > TRANSCRIPT_SEARCH_CONTEXT_CHARS) target.pop();
      else if (refs?.length) citations.push({row, refs});
    }
  }
  for (const {row, refs} of citations) {
    row.citations = [];
    for (const ref of refs) {
      const {id, materialId, version, locator, value, period, display_unit, derivedFrom} = ref;
      row.citations.push({id, materialId, version, locator, value, period, display_unit, derivedFrom});
      if (JSON.stringify(compact).length > TRANSCRIPT_SEARCH_CONTEXT_CHARS) { row.citations.pop(); break; }
    }
    if (!row.citations.length) delete row.citations;
  }
  return JSON.stringify(compact);
}
function sourceEvidence(active,transcript,query,callId) {
  if (!active?.admitted || active.plan?.route==='ordinary') return [];
  const rows=active.sourceRows??=new Map();
  const out=[];
  for (const match of transcript.matches) {
    if (match.role!=='assistant') continue;
    for (const c of match.citations??[]) {
      if (!c.id || !c.version || !c.materialId || !c.locator) continue;
      const handle=randomUUID();
      const itemIds=(active.plan.items??[]).filter(i=>i.action==='search' && (!i.query || i.query.toLowerCase()===query.toLowerCase()) &&
        (!i.turn || match.turn===i.turn) && (!i.book || [c.filename,c.storedFilename].includes(i.book))).map(i=>i.id);
      const evidence={handle,itemIds,sourceTurnId:match.sourceTurnId??match.legacyAnchor,turn:match.turn,
        sourceRelations:match.sourceClaims?.filter(row=>row.citationIds.includes(c.id)).map(row=>row.relation),
        sourceStatus:match.sourceStatus??'unknown',sourceLimits:match.sourceLimits??[],relation:'historical',
        id:c.id,materialId:c.materialId,version:c.version,locator:c.locator,filename:c.filename,storedFilename:c.storedFilename};
      rows.set(handle,{evidence,query,callId,rev:active.plan.rev,branch:active.plan.branch});
      out.push(evidence);
    }
  }
  return out;
}

export function createTranscriptSearchTool({getMessages,getLedger,getActive}) {
  return {name:'transcript_search',label:'检索前文与台账',description:'搜索本会话前文用户问题与助手最终回答，并同时检索本会话台账（用户主张/更正/事实），返回轮次、角色、摘录与覆盖范围。',
    promptSnippet:'transcript_search：检索本会话历史问答并返回台账命中',promptGuidelines:['自查、复核前文或「你之前说过」类问题必须先调用 transcript_search；它同时返回 ledgerMatches（可为空）。逐条核对 claim/correction，金额用 unit_convert/calc；没有候选人写「未发现候选人」，不得靠记忆声称「全部正确/没有十倍错误」。只问先前答文引用了哪一格时，按命中的助手答文报告原出处。当前数值须另行取证。'],
    parameters:Type.Object({query:Type.String({minLength:1}),turn:Type.Optional(Type.Integer({minimum:1})),turnRange:Type.Optional(Type.Array(Type.Integer({minimum:1}),{minItems:2,maxItems:2})),limit:Type.Optional(Type.Integer({minimum:1,maximum:50})),handle:Type.Optional(Type.String({maxLength:80}))}),
    execute:async(_id,p)=>{
      if(!String(p.query||'').trim())return {content:[{type:'text',text:'query 不能为空'}],isError:true};
      const active=getActive?.();
      if (p.handle) {
        const row=active?.sourceRows?.get(p.handle);
        if (!row || row.rev!==active.plan.rev || row.branch!==active.plan.branch || row.query!==p.query)
          return {content:[{type:'text',text:'此证据句柄不属于当前请求范围'}],isError:true};
        return {details:{sourceEvidence:[row.evidence],projectionOnly:true},content:[{type:'text',text:JSON.stringify(row.evidence)}]};
      }
      const messages=getMessages();
      const transcript=searchTranscript(messages,p);
      const ledger = getLedger ? await getLedger() : null;
      const ledgerResult = ledger ? searchLedger(ledger, p) : null;
      const details = {
        ...transcript,
        ...(active?.plan?.route && active.plan.route!=='ordinary'?{sourceEvidence:sourceEvidence(active,transcript,p.query,_id)}:{}),
        ...(ledgerResult ? {
          ledger, ledgerMatches: ledgerResult.matches, ledgerTotalMatches: ledgerResult.totalMatches,
          ledgerCoverage: ledgerResult.coverage,
        } : {}),
      };
      return {content:[{type:'text',text:modelSearchText(details)}],details};
    }};
}
