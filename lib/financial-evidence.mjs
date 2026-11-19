/** Verify each stated amount against one source with the same identity. */
import { adoptedCitations, collectCitationsFromToolCalls, currentCitation, derivedEvidenceIssue } from './citations.mjs';
import { citationIdentity, extractLocatorMatches, maskCitationIds } from './citation-locator.mjs';
import { normalizeValue, norm } from './fact-memory/value.mjs';
import { Lexer } from 'marked';

const metrics = [
  ['收入','营收','营业收入','营业额','revenue','sales','turnover'], ['净利润','净利','net income','net profit'],
  ['利润','profit'], ['成本','营业成本','cost','cogs'], ['毛利润','毛利','gross profit'], ['毛利率','gross margin'],
  ['净利率','net margin'], ['资产','总资产','assets'], ['预付款','预付账款'], ['现金流','cash flow'],
  ['企业价值','enterprise value'], ['股权价值','equity value'], ['净负债','net debt'],
  ['ebitda','息税折旧摊销前利润'], ['折旧','depreciation'], ['资本开支','capex'], ['营业利润','operating profit'],
];
const scopes = [['合并','consolidated'],['单体','母公司','standalone']];
const bases = [['实际','actual'],['预测','预计','forecast','estimate'],['假设','assumption']];
const scenarios = [['基准','基本情景','base'],['乐观','上行','bull','upside'],['悲观','下行','bear','downside']];
const currencyPattern = /人民币|港(?:币|元)|美元|美金|HK\$|US\$|CNY|RMB|HKD|USD/ig;
const periodPattern = /(?:FY\s*)?(?:19|20)\d{2}(?:\s*年)?(?:\s*(?:[QH][1-4]|[AE](?![A-Za-z])))?|(?:[1-4]Q|[12]H)\s*\d{2,4}/gi;
const number = String.raw`[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const monetaryScale = String.raw`(?:十亿|百万|千万|千|万|亿)?(?:美元|港元|港币|人民币|元)(?:\/股)?|十亿|百万|亿|万`;
const amount = new RegExp(String.raw`(?<![\d.A-Za-z])(?:(USD|CNY|RMB|HKD|HK\$|US\$|人民币)\s*)?(${number})\s*(个百分点|[%％倍]|${monetaryScale}|(?:(?:RMB|CNY|HKD|USD)\s*)?(?:million|mn)\b|(?:RMB|CNY|HKD|USD)\b)?`, 'gi');
const cents = x => String(x ?? '').replaceAll(',','').replace('−','-');
const equalValue = (a,b) => a != null && b != null && cents(a).trim() && cents(b).trim() &&
  Number.isFinite(Number(cents(a))) && Number(cents(a)) === Number(cents(b));
const unique = values => [...new Set(values.filter(Boolean))];
const fieldNames = {value:'数值', unit:'单位', currency:'币种', metric:'指标', period:'期间', company:'主体', scope:'合并范围', basis_type:'实际或预测口径', scenario:'情景', version:'资料版本', dependency:'派生依赖'};
function currencyOf(s) {
  const label = s?.match(currencyPattern)?.[0];
  if (!label) return '';
  return /港|hk/i.test(label) ? 'HKD' : /美|us/i.test(label) ? 'USD' : 'CNY';
}
function units(s = '') {
  return s.replace(/(?:美元|港元|港币|人民币)/g, '元').replace(/^(?:RMB|CNY|USD|HKD)$/i,'元').replace('％','%');
}
function comparable(value, unit, currency) {
  const normalized = normalizeValue(cents(value),units(unit),currencyOf(unit) || currency);
  return normalized.reason ? null : normalized;
}
function sameAmount(claim, cell) {
  if (!claim.unit) return equalValue(claim.value,cell.value) ? null : 'value';
  const cellUnit = cell.raw_unit || cell.display_unit || '';
  if (!cellUnit || cellUnit === 'unit_unknown') return 'unit';
  const a = comparable(claim.value,claim.unit,claim.currency);
  const b = comparable(cell.value,cellUnit,cell.currency);
  if (!a || !b) return norm(units(claim.unit)) === norm(units(cellUnit)) && equalValue(claim.value,cell.value) ? null : 'unit';
  if (a.canonical_unit !== b.canonical_unit) return 'unit';
  if (a.canonical_value === b.canonical_value) return null;
  return equalValue(claim.value,cell.value) && a.multiplier !== b.multiplier ? 'unit' : 'value';
}
function groupKey(v, groups) {
  const key = norm(v);
  return groups.find(group => group.some(label => norm(label) === key))?.[0] || key;
}
function lastLabel(text, labels) {
  const input = text.toLowerCase();
  let bestEnd = -1, best = '';
  for (const label of labels) {
    const word = label.trim().toLowerCase();
    if (!word) continue;
    const start = input.lastIndexOf(word);
    if (start < 0 || (/^[\w ]+$/.test(word) && /[a-z]/.test(input[start-1] || ''))) continue;
    const end = start + word.length;
    if (/^[a-z ]+$/.test(word) && /[a-z]/.test(input[end] || '')) continue;
    if (end > bestEnd || (end === bestEnd && word.length > best.length)) { best = word; bestEnd = end; }
  }
  return best;
}
function periodParts(text) {
  const p = norm(text).replace('fy','').replace('年','');
  const short = p.match(/^([1-4])([qh])(\d{2}|\d{4})$/);
  const period = short ? (short[3].length === 2 ? '20' : '') + short[3] + short[2] + short[1] : p.replace(/[ae]$/,'');
  return {period, basis_type:/e$/.test(p)?'forecast':/a$/.test(p)?'actual':''};
}
function plainText(s) {
  // Hide filenames, versions and coordinates without changing offsets.
  let text = s.replace(/[*`]/g,' ');
  // Digits in material identifiers are metadata, including when an ID
  // follows a numeric-looking introduction such as “材料 ID 为 …”.
  text = text.replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi, id => ' '.repeat(id.length));
  for (const m of extractLocatorMatches(text).reverse()) text = text.slice(0,m.index) + ' '.repeat(m.raw.length) + text.slice(m.index+m.raw.length);
  return text;
}

function* statements(answer) {
  const prose = s => s.split(/[。！？；;\n]|(?<=[.!?])\s+/).filter(Boolean);
  if (!answer.includes('|')) { yield* prose(answer); return; }
  for (const token of Lexer.lex(answer)) {
    if (token.type !== 'table') { yield* prose(token.raw); continue; }
    const headers = token.header.map(h => h.text);
    for (const row of token.rows) {
      const shared = row.filter(c => !/\d/.test(plainText(c.text)) && !c.text.includes('!')).map(c => c.text).join(' ');
      const refs = row.filter(c => c.text.includes('!') && !/\d/.test(plainText(c.text))).map(c => c.text).join(' ');
      for (const [i, cell] of row.entries()) {
        if (/\d/.test(plainText(cell.text))) yield [shared,headers[i],'为',cell.text,cell.text.includes('!')?'':refs].join(' ');
      }
    }
  }
}
function questionMetrics(question, candidates) {
  const labels = unique([...metrics.flat(), ...candidates.map(c => c.metric)]);
  const pattern = labels.toSorted((a,b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  const mentions = [...question.matchAll(new RegExp(pattern, 'gi'))];
  const keys = unique(mentions.map(m => groupKey(m[0], metrics)));
  const inherited = keys.length === 1 ? keys[0] : '';
  const last = mentions.at(-1);
  if (!inherited) return {labels, inherited, requested:''};
  const tail = question.slice(last.index + last[0].length).trim().replace(/[？?。.]$/, '').trim();
  const head = question.slice(0, last.index).replace(periodPattern, '').trim();
  const direct = /^(?:是|为|有)?\s*多少(?:钱)?$/.test(tail) || (!tail &&
    /^(?:(?:请\s*)?(?:帮我\s*)?(?:给出|列出|提供|查询)|请问|what (?:is|was)(?: the)?)$/i.test(head));
  return {labels, inherited, requested:direct ? inherited : ''};
}
function statedMetric(prefix, labels) {
  const unknownMetric = prefix.match(/([\p{Script=Han}]{2,10}(?:余额|款项|负债|支出|拨备))\s*(?:为|是|[:：])?\s*$/u)?.[1];
  return lastLabel(prefix,labels) || unknownMetric || '';
}
function claimDimensions(prefix, question, candidates, metricContext) {
  const labelsFor = (field,groups) => unique([...groups.flat(), ...candidates.map(c=>c[field])]);
  const metric = statedMetric(prefix,metricContext.labels) || metricContext.inherited;
  const namedSubject = text => text.match(/(?:^|[，,、(（\s])([A-Z][A-Za-z0-9-]{1,30})\s+(?=(?:的\s*)?(?:合并|单体|收入|成本|净利|revenue|profit))/)?.[1];
  const explicit = prefix.match(/(?:主体|公司|entity|company)\s*[:：]\s*([\w.-]+|[\p{Script=Han}]+?公司)/iu)?.[1] ||
    prefix.match(/(?:^|[\s，,])([\p{Script=Han}]{1,10}(?:公司|集团))(?=\s|的|合并|单体|[12]\d{3}|收入|成本|净利)/u)?.[1];
  const period = [...prefix.matchAll(periodPattern)].at(-1)?.[0];
  const periodsAsked = unique(question.match(periodPattern) || []);
  const parts = periodParts(period || (periodsAsked.length === 1 ? periodsAsked[0] : ''));
  const dimension = (field,groups) => {
    const labels = labelsFor(field,groups);
    const value = lastLabel(prefix,labels);
    const asked = unique(labels.filter(label => lastLabel(question,[label])).map(v=>groupKey(v,groups)));
    return value || (asked.length === 1 ? asked[0] : '');
  };
  const ratio = /占比|增速|增长率|百分比变化|份额|比重|\bratio\b|\bshare\b/i.exec(prefix);
  return { ...parts, metric, company: explicit || dimension('company',[]) || namedSubject(prefix) || namedSubject(question), scope:dimension('scope',scopes),
    basis_type:lastLabel(prefix,bases.flat()) || parts.basis_type || dimension('basis_type',bases),
    scenario:dimension('scenario',scenarios), ratio: ratio?.[0] || '' };
}
function compare(claim, cell, deps) {
  if (cell.derivedFrom || cell.role?.startsWith('derived')) {
    const issue = derivedEvidenceIssue(cell, deps.sources, deps.calls);
    if (issue) return ['dependency',issue];
  }
  if (!currentCitation(cell,deps.versions)) return ['version',String(deps.versions[cell.materialId])];
  const mismatch = (field, expected) => [field,expected || '出处缺少该字段'];
  if (claim.period && periodParts(cell.period).period !== claim.period) return mismatch('period',cell.period);
  for (const [field,groups] of [['company',[]],['scope',scopes],['basis_type',bases],['scenario',scenarios]]) {
    if (!claim[field]) continue;
    const source = field === 'basis_type' && (!cell[field] || cell[field] === 'unknown') ? periodParts(cell.period).basis_type : cell[field];
    if (groupKey(claim[field],groups) !== groupKey(source,groups)) return mismatch(field,source);
  }
  const sourceCurrency = currencyOf(cell.currency || '') || currencyOf(cell.raw_unit || cell.display_unit || '');
  if (claim.currency && sourceCurrency !== claim.currency) return mismatch('currency',sourceCurrency);
  if (claim.metric && !cell.metric && (cell.period || cell.company || cell.scope || cell.basis_type)) return mismatch('metric',null);
  if (claim.metric && cell.metric && groupKey(claim.metric,metrics) !== groupKey(cell.metric,metrics) &&
      !(claim.ratio && norm(cell.metric).includes(norm(claim.metric)) && norm(cell.metric).includes(norm(claim.ratio)))) return mismatch('metric',cell.metric);
  if (claim.ratio && cell.role !== 'derived_ratio' && !/占比|增速|增长率|比重|份额|ratio|growth|share/i.test(cell.metric || '')) return mismatch('metric',cell.metric);
  const field = sameAmount(claim,cell);
  return field ? mismatch(field,field === 'unit' ? cell.display_unit || cell.raw_unit : cell.value) : null;
}

export function financialEvidenceFindings(answer, context, ledgerSources) {
  const calls = context.toolCalls || [];
  const current = context.citations || [];
  const raw = collectCitationsFromToolCalls(calls);
  const all = [...new Map([...current,...raw].map(c=>[c.id,c])).values()];
  const candidates = [...all, ...ledgerSources];
  const question = context.question || '';
  const metricContext = questionMetrics(question, candidates);
  const reportedMetrics = new Set();
  const deps = {sources:new Map(current.filter(c=>currentCitation(c,context.currentVersions)).map(c=>[c.id,c])), calls, versions:context.currentVersions};
  const findings = [];
  for (const statement of statements(answer)) {
    const clean = plainText(maskCitationIds(statement, context.locatorCitations || current));
    const refs = extractLocatorMatches(statement);
    const amounts = [...clean.matchAll(amount)].filter(m => {
      if (m[1] || m[3]) return true;
      const at = m.index, before = clean.slice(0,at), after = clean.slice(at+m[0].length);
      if (/(?:storedFilename|materialId|filename|存储文件名|文件名|版本号?|version)\s*(?:为|是)?\s*[:：=]?\s*$/i.test(before)) return false;
      if (/(?:19|20)\d{2}/.test(m[2]) && /^(?:年|[AEQH])/.test(after) || /^\s*年/.test(after)) return false;
      return (refs.length || candidates.some(c=>c.metric)) && (/(?:为|是|[:：=])\s*$/.test(before) || /分别|各自/.test(before)) && !/^\s*[年月日]/.test(after);
    });
    for (const [i,m] of amounts.entries()) {
      const previous = amounts[i-1], next = amounts[i+1];
      const start = previous ? previous.index + previous[0].length : 0;
      const clauses = clean.slice(start,m.index).split(/[，,()（）]/);
      const clause = clauses.pop();
      const prefix = [...clauses.filter(part => !/未核验|未验证|待核/.test(part)), clause].join('，');
      const suffix = clean.slice(m.index+m[0].length,next?.index);
      // A qualification must apply to this assertion. An aside about a
      // different unverified item cannot exempt a completed amount.
      if (/未核验|未验证|待核|例如|比如|举例/.test(clause) ||
          /^\s*[（(]\s*(?:未核验|未验证|待核)\s*[）)]/.test(suffix) ||
          /(?:例如|比如|举例)[：:]?\s*$/.test(prefix)) continue;
      const identity = claimDimensions(prefix,question,candidates,metricContext);
      const names = clean.slice(0,amounts[0].index).match(/([^，,；;：:]+?)\s*(?:分别|各自)\s*(?:为|是)\s*$/)?.[1]?.split(/和|与|及|、/);
      if (names?.length === amounts.length) identity.metric = statedMetric(names[i], metricContext.labels);
      const local = statement.slice(start,next?.index);
      const localRefs = extractLocatorMatches(local);
      const nextRefs = localRefs.filter(r => r.index >= m.index - start);
      const ref = nextRefs[0] || localRefs.at(-1) || (refs.length === 1 ? refs[0] : null);
      const claim = {...identity,value:m[2],unit:m[3]?.trim() || (m[1] ? '元' : ''),
        currency:currencyOf([m[1],m[3],suffix.match(/^\s*(人民币|美元|港元|港币|USD|CNY|RMB|HKD)/i)?.[1],prefix].filter(Boolean).join(' '))};
      if (!ref && /可能|若|如果|假设/.test(prefix)) continue;
      if (claim.metric) reportedMetrics.add(groupKey(claim.metric, metrics));
      let pool = candidates;
      if (ref) {
        const fresh = adoptedCitations(ref.raw,current);
        const adopted = fresh.length ? fresh : adoptedCitations(ref.raw,all);
        pool = all.filter(c=>adopted.some(a=>citationIdentity(a)===citationIdentity(c) && a.locator===c.locator));
      }
      const issues = pool.map(c=>compare(claim,c,deps));
      if (issues.some(issue=>!issue)) continue;
      // Older registers can hold corrections and quotes without a unit or
      // financial identity. They remain usable as standalone legacy amounts.
      if (!ref && ledgerSources.some(c=>c.legacy && !c.display_unit && !c.metric && equalValue(c.value,claim.value))) continue;
      const relevant = issues.find(why=>why[0]==='dependency') || issues.find(why=>why[0]==='value') || issues[0];
      const field = relevant?.[0], expected = relevant?.[1];
      findings.push({rule:field && (field !== 'value' || ref) ? 'evidence_identity_mismatch' : 'unsourced_number',severity:'error',field:field || 'source',
        message:field?`主张的${fieldNames[field]}与出处不匹配`:'主张数字没有完整登记或本轮结构化出处',
        excerpt:statement.trim(),expected: expected != null ? String(expected) : '核验同一指标、期间和单位的来源'});
    }
  }
  if (metricContext.requested && reportedMetrics.size && !reportedMetrics.has(metricContext.requested)) {
    findings.push({rule:'unanswered_metric', severity:'error', message:`答文未给出所问指标：${metricContext.requested}`,
      excerpt:[...reportedMetrics].join('、'), expected:metricContext.requested});
  }
  return findings;
}
