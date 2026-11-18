import { isWorkbookMetricName } from '../../lib/workbook-query.mjs';
import { Lexer } from 'marked';
import { citationLookup } from '../../lib/citations.mjs';
import { citationIdentity, citationQualifiers, extractLocatorMatches, LOCATOR_SOURCE, locatorKey, resolveLocatorToken } from '../../lib/citation-locator.mjs';

// Keep exactly the source cells an explicit reference resolves to, including
// a covered range and the UI's "Sheet!A1、A2" shorthand.
const SHORTHAND_CELL = /\s*[、,，]\s*(`*)(\$?[a-z]{1,3}\$?\d{1,7})(?![\w!:])\1/iy;

export function adoptedCitations(text, available) {
  const lookup = citationLookup(available);
  const used = new Map();
  const adopt = cell => {
    // Removing unused evidence must not make an ambiguous reference clickable
    // on refresh. Preserve that ambiguity on the remaining cell.
    const ambiguousQualifiers = citationQualifiers(cell).filter(source => lookup.isAmbiguous(locatorKey(cell.locator), source));
    used.set(cell.id, ambiguousQualifiers.length ? { ...cell, ambiguousQualifiers } : cell);
  };
  for (const match of extractLocatorMatches(text)) {
    const cells = [];
    const resolved = resolveLocatorToken(match.raw, { get(key, source) {
      const cell = lookup.get(key, source);
      if (cell) cells.push(cell);
      return cell;
    } });
    if (!resolved?.citation) continue;
    const source = citationIdentity(resolved.citation);
    const sheet = resolved.locator.split('!')[0];
    for (const cell of cells) if (citationIdentity(cell) === source && cell.locator.split('!')[0].toLowerCase() === sheet.toLowerCase()) adopt(cell);
    const tail = text.slice(match.index + match.raw.length).replace(/^`+/, '');
    const adjacentCell = new RegExp(SHORTHAND_CELL);
    for (let next; (next = adjacentCell.exec(tail));) {
      const coord = next[2];
      const cell = lookup.get((sheet + '!' + coord.replaceAll('$', '')).toLowerCase(), source);
      if (cell) adopt(cell);
    }
  }
  return [...used.values()];
}

// A search hit vouches for what an earlier answer cited. It supplies a
// versioned link in a source report, never a fresh reading of that cell.
const HISTORY = /历史|前文|此前|先前|之前|当时|原文|原答|已交付|[上首前]一?[轮次]|第\s*[一二三四五六七八九十百\d]+\s*[轮次]|那[条份次个](?:正式)?(?:回[答复]|答[文案])|\b(?:previous|prior|earlier|original|last)\b/i;
const REFERENCE = /引用|援引|出处|出自|来源|依据|定位|单元格|坐标|\b(?:cit(?:e[ds]?|ation)|refer(?:ence[ds]?|red)?|cell|source)\b/i;
// An elliptical reply to a provenance question can just name the source.
// Keep this fallback narrow: e.g. “收入有望增长，依据 …” asserts a fact.
const SOURCE_ONLY = /^[\s`*_]*(?:(?:它|其|所)?(?:引用|援引)(?:的)?(?:单元格|坐标)?|(?:该|对应的?)?(?:出处|来源|单元格|坐标))?(?:就?是|为|在)?[\s`*_。、，,：:！!.]*$/i;

// Every locator must be the object of the source report. In “the old
// answer cited A1, which proves revenue grew” a citation cannot verify growth.
const REPORTED_CELL = /(?:引用|援引|出处|出自|指向|依据|来源|坐标|单元格|cit(?:ed|ation)|refer(?:red to|enced)|source|cell)\s*(?:的|是|为|在|了|就是|写作|写为|is|was|:|：|\s)*$/i;

const VERSION_LABEL = String.raw`(?:[\da-z_-]+(?:\.[\da-z_-]+)*|[零〇一二两三四五六七八九十百千]+)`;
const SOURCE_VERSION = new RegExp(String.raw`(?:(?:材料|文件)(?:的)?\s*)?(?:版本(?:号)?|\bversion)\s*(?:为|是|[:=])?\s*v?\s*(${VERSION_LABEL})|(?:材料|文件)?第\s*(${VERSION_LABEL})\s*版|(?<!\w)@?v(\d+(?:\.\d+)*)\b`, 'gi');

// Check descriptive fields against the source of the written locator. Keep the
// original answer and its qualifiers intact for lint, delivery and linking.
function checkSourceFields(clause, refs, lookup, precedingSource) {
  const resolved = refs.map(ref => resolveLocatorToken(ref.raw, lookup)?.citation);
  let conflict = '';
  let hasFields = false;
  function check(segment, source) {
    let text = segment.normalize('NFKC').replace(/^\s*[-•]\s+/, '').replace(/[`*]/g, '');
    if (source?.filename) {
      const filename = source.filename.normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameField = String.raw`(?:(?:工作簿|文件)(?:名(?:称)?)?\s*(?:为|是|:)?\s*)?`;
      text = text.replace(new RegExp(nameField + String.raw`(?<![\w.-])` + filename, 'g'), ' ');
    }
    const otherWorkbook = text.match(/[^\s()[\]，,。；;]+\.xls[xm]\b/i);
    if (otherWorkbook) conflict = otherWorkbook[0];
    text = text.replace(/(?:材料|文件|material|file)\s*ID\s*(?:为|是|[:=])?\s*([\w-]+)/gi, (field, id) => {
      hasFields = true;
      if (source?.materialId !== id) conflict = field;
      return ' ';
    });
    text = text.replace(SOURCE_VERSION, (field, labeled, numbered, short) => {
      hasFields = true;
      if (source?.version !== ordinal(labeled || numbered || short)) conflict = field;
      return ' ';
    });
    return text.replace(/\([\s,、]*\)/g, ' ');
  }
  let checked = '';
  let end = 0;
  for (const [i, ref] of refs.entries()) {
    const previous = resolved[i - 1];
    const source = resolved[i];
    let gap = clause.slice(end, ref.index);
    // A parenthetical immediately following the previous cell belongs to it.
    // Unattached fields between different sources have no unique owner.
    if (i && previous && source && citationIdentity(previous) !== citationIdentity(source)) {
      const note = gap.match(/^\s*[（(][^()（）]*[)）]/)?.[0] || '';
      checked += check(note, previous);
      gap = gap.slice(note.length);
      checked += check(gap, null);
    } else {
      checked += check(gap, source);
    }
    checked += ref.raw;
    end = ref.index + ref.raw.length;
  }
  const lastSource = refs.length ? resolved.at(-1) : precedingSource;
  checked += check(clause.slice(end), lastSource);
  return { checked, conflict, hasFields, lastSource };
}

const ALTERNATE_SPELLING = /^\s*(?:(?:当|若|如果|为避免)[^，,。；;]{0,48}(?:同名|重名)(?:时)?[,，]\s*)?(?:应当|应该|应|也可|可以|可)?(?:写作|写为|记作|表示为)\s*[:：]?\s*$/;
function reportsHistoricalSource(part, refs, question, alternateSpelling) {
  let description = part.replace(new RegExp(LOCATOR_SOURCE, 'g'), ' ');
  const historicalSubject = HISTORY.test(description);
  description = description.replace(/第\s*\d+\s*[轮次]|\bturn\s*#?\d+|\d+\s*条(?=\s*(?:命中|记录|结果|[，,。；;]|$))/gi, ' ');
  if (/\d|当前|现在|最新|现价|[零〇一二两三四五六七八九十百千万亿]+(?:元|美元|港元|%)|\b(?:current|now|latest)\b/i.test(description)) return false;
  if (HISTORY.test(question) && REFERENCE.test(question) && SOURCE_ONLY.test(description.trim())) return true;
  if (!alternateSpelling && !historicalSubject && !(HISTORY.test(question) && /回[答复]|答[文复案]|\b(?:reply|answer)\b/i.test(description))) return false;
  return refs.every(({ raw, index }) => {
    const prefix = part.slice(0, index).replace(/[`*_]/g, '').trimEnd();
    const suffix = part.slice(index + raw.length).replace(/[`*_]/g, '').trim();
    // Keep the link in the report itself (including a trailing source ID).
    // “The old answer cited B2, proving that …” also makes a new claim.
    const sourceTail = /^(?:(?:这[个一]|该)?(?:单元格|坐标)|cell)?[。，,；;！.!（）()\s]*$/i.test(suffix);
    const sourceFirst = /^(?:是|为|was|is).*(?:引用|援引|referenced|cited)(?:的(?:单元格|坐标|出处))?[。.!！]?$/i.test(suffix);
    // In “引用的是 Book.xlsx 的 B2 单元格” the source noun follows the
    // locator. The filename was already checked and removed from the prefix.
    const sourcePrefix = prefix.replace(/(?:工作簿|文件|workbook)?\s*(?:中的?|里的?|内的?|的)\s*$/i, '').trimEnd();
    return ((REPORTED_CELL.test(prefix) || REPORTED_CELL.test(sourcePrefix) ||
      (alternateSpelling && ALTERNATE_SPELLING.test(prefix))) && sourceTail) || sourceFirst;
  });
}

function ordinal(label) {
  if (/^\d+$/.test(label)) return Number(label);
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(label)) return NaN;
  let number = 0;
  let digit = 0;
  for (const ch of label) {
    const unit = { 十: 10, 百: 100, 千: 1000 }[ch];
    if (unit) {
      number += (digit || 1) * unit;
      digit = 0;
    } else {
      digit = '零一二三四五六七八九'.indexOf(ch.replace('两', '二').replace('〇', '零'));
    }
  }
  return number + digit;
}

function explicitTurns(text) {
  const turns = new Set();
  for (const match of text.matchAll(/第\s*([零一二三四五六七八九十百千\d]+)\s*[轮次]|\bturn\s*#?(\d+)/gi)) {
    turns.add(ordinal(match[1] || match[2]));
  }
  if (/首轮/.test(text)) turns.add(1);
  return turns;
}

export function reportedLocatorEvidence(text, question, current, matches) {
  const fallback = { citations: current };
  if (!matches.length && !(HISTORY.test(question) && REFERENCE.test(question))) return fallback;
  const requested = explicitTurns(question);
  const allowed = matches.filter(match => !requested.size || requested.has(match.turn));
  const used = new Map();
  const bindings = [];
  let hasHistoricalLink = false;
  let precedingSource;
  for (const { parts } of answerBlocks(text)) {
    for (const [partIndex, part] of parts.entries()) {
      const reported = explicitTurns(part);
      const cells = allowed.filter(match => !reported.size || reported.has(match.turn)).flatMap(match => match.citations);
      const historyLookup = citationLookup(cells);
      for (const [i, clause] of part.split(/[；;]/).entries()) {
        const refs = extractLocatorMatches(clause);
        let noteSource = precedingSource;
        if (!refs.length && !noteSource) {
          // A standalone version or ID may also introduce the next source.
          const nextRef = extractLocatorMatches(parts[partIndex + 1])[0];
          if (!nextRef || !REFERENCE.test(question)) continue;
          noteSource = resolveLocatorToken(nextRef.raw, historyLookup)?.citation;
        }
        const fields = checkSourceFields(clause, refs, historyLookup, noteSource);
        if (!refs.length) {
          // Only an adjacent source note can qualify the preceding citation.
          const sourceNote = /材料|文件|工作簿|版本|引用记录|material|file|version/i.test(clause) && !/当前|现在|最新/.test(clause);
          if (fields.conflict && sourceNote) return { citations: [], conflict: fields.conflict };
          const noteOnly = /^(?:[\s。，,.()（）:：]|该|这|那|份|其|的|为|是|中|对应|引用|记录|回答|工作簿|材料|文件)*$/.test(fields.checked);
          // A financial gloss can follow a source report after a full stop.
          // The historical hit cannot stand in for a direct read of that cell.
          const cellClaim = /^(?:对应|其|该|这|上述|前述)/.test(clause.trim()) &&
            /数值|常量值|期间|单位|收入|营收|利润|金额|增长|下降/.test(fields.checked);
          if (cellClaim && precedingSource && !current.some(cell => citationIdentity(cell) === citationIdentity(precedingSource) &&
            locatorKey(cell.locator) === locatorKey(precedingSource.locator))) return { citations: [], conflict: clause };
          if ((i || (sourceNote && fields.hasFields)) && !noteOnly) {
            return { citations: [], conflict: clause };
          }
          if (!sourceNote) precedingSource = undefined;
          continue;
        }
        const checkedRefs = extractLocatorMatches(fields.checked);
        // An adjacent clause may spell out the very same link using its
        // material ID to disambiguate a filename.
        const alternateSpelling = precedingSource && checkedRefs.length === 1 &&
          ALTERNATE_SPELLING.test(fields.checked.slice(0, checkedRefs[0].index));
        if (alternateSpelling && (!fields.lastSource ||
            citationIdentity(fields.lastSource) !== citationIdentity(precedingSource) ||
            locatorKey(fields.lastSource.locator) !== locatorKey(precedingSource.locator))) {
          return { citations: [], conflict: refs[0].raw };
        }
        const isReport = reportsHistoricalSource(fields.checked, checkedRefs, question, alternateSpelling);
        // Resolve historical prose solely against the cited turn. A current
        // reading of the same coordinate can belong to a different version.
        const evidence = isReport ? cells : current;
        const lookup = isReport ? historyLookup : citationLookup(current);
        if (isReport && fields.conflict) return { citations: [], conflict: fields.conflict };
        for (const { raw } of refs) {
          const source = resolveLocatorToken(raw, lookup)?.citation;
          if (!source) return isReport ? { citations: [], conflict: raw } : { citations: [] };
          bindings.push({ raw, identity: citationIdentity(source) });
        }
        for (const cell of adoptedCitations(clause, evidence)) used.set(cell.id, cell);
        precedingSource = isReport ? fields.lastSource : undefined;
        hasHistoricalLink ||= isReport;
      }
    }
  }
  if (!hasHistoricalLink) return fallback;
  const citations = [...used.values()];
  const delivered = citationLookup(citations);
  // The browser has one citation list for the entire answer. Each written
  // locator must still select its own source after the lists are combined.
  for (const { raw, identity } of bindings) {
    const source = resolveLocatorToken(raw, delivered)?.citation;
    if (!source || citationIdentity(source) !== identity) return { citations: [], conflict: raw };
  }
  return { citations };
}

export function joinContinuation(prefix, delta) {
  if (!prefix || delta.startsWith(prefix)) return delta;
  const continuation = delta.trimStart();
  const original = prefix.trimStart();
  if (continuation.startsWith(original)) return prefix + continuation.slice(original.length);
  // Check the longest recent overlap first. At a clause boundary, a shorter
  // match can indicate a restart. Ignore short repeats and mid-word matches.
  const span = Math.min(512, original.length, continuation.length);
  for (let start = original.length - span; start < original.length; start++) {
    const repeated = original.slice(start);
    if (!continuation.startsWith(repeated)) continue;
    const before = original.slice(0, start);
    if (/[\p{Script=Latin}\d]$/u.test(before) && /^[\p{Script=Latin}\d]/u.test(repeated)) continue;
    const clauseStart = !before || /[。！？.!?；;，,：:\n]\s*$/u.test(before);
    const han = repeated.match(/\p{Script=Han}/gu)?.length || 0;
    const words = repeated.match(/[\p{Script=Latin}\d]+/gu)?.length || 0;
    // A short metric label can be replayed at a sentence restart. Keep
    // ordinary three-character phrases, which may be repeated for emphasis.
    const restartsShortLabel = /[。！？.!?]\s*$/u.test(before) &&
      /^(?:\p{Script=Han}{2}[率额量值价数]|净利润)$/u.test(repeated) &&
      /^(?:\p{Script=Han}|\s*[:：])/u.test(continuation.slice(repeated.length));
    if (restartsShortLabel || han >= (clauseStart ? 4 : 5) || words >= (clauseStart ? 2 : 3)) {
      return prefix + continuation.slice(repeated.length);
    }
  }
  return prefix + delta;
}

export function answerGaps(answer) {
  return [...answer.matchAll(/(?:^|[。！？\n])[ \t]*(?:[-*][ \t]+)?未核验[：:][ \t]*([^。！？\n]+)/g)]
    .map(match => match[1].trim()).filter(Boolean);
}

const PERIOD_PREFIX = /^20\d{2}\s*年\s*[，,、]?\s*/;
const NUMBER = String.raw`[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;

function requestedItems(question) {
  const request = question.trim().replace(/^(?:请问|请)?\s*(?:帮我\s*)?/, '').replace(/[？?。]$/, '');
  const numeric = request.match(/^([\p{L}\p{N} 、，,]+?)(?:各自?|分别)?\s*(?:是|为)?\s*多少$/u);
  const list = numeric || request.match(/^(?:分别\s*)?(?:给出|列出)\s*([\p{L}\p{N} 、，,]+)$/u);
  const items = list?.[1].replace(PERIOD_PREFIX, '').trim().split(/\s*(?:和|与|及|[、，,])\s*/);
  return { items: items?.length > 1 && items.every(Boolean) ? [...new Set(items)] : [], numeric: Boolean(numeric) };
}

// Keep the original Markdown for delivery. A table row is a single claim
// unit, just as a sentence is in prose. Its header belongs to the retained rows.
export function answerBlocks(text) {
  const prose = raw => ({ parts: raw.split(/(?<=[。！？])|(?<=[.!?])(?=\s|$)|\n+/).map(s => s.trim()).filter(Boolean) });
  if (!text.includes('|')) return [prose(text)];
  return Lexer.lex(text).map(token => {
    if (token.type !== 'table') return prose(token.raw);
    const [header, separator, ...rows] = token.raw.trimEnd().split('\n');
    return { header: header + '\n' + separator, parts: rows,
      labels: token.header.map(cell => cell.text.replace(/[*`]/g, '').trim()), cells: token.rows };
  });
}

// Expand ordered values into named claims for verification. Delivery always
// uses the original text and Markdown cells.
function claimViews(block, row, items, orderedList) {
  const raw = block.parts[row].replace(/[*`]/g, '');
  if (block.header) {
    if (block.labels.some(label => items.includes(label))) {
      return block.cells[row].flatMap((cell, i) => items.includes(block.labels[i])
        ? [block.labels[i] + ' ' + cell.text.replace(/[*`]/g, '')] : []);
    }
    return [block.cells[row].map(cell => cell.text.replace(/[*`]/g, '')).join(' | ')];
  }
  return raw.split(/[；;]|[，,](?=\s*(?:根据|依据))/).map(clause => {
    const list = orderedList.exec(clause);
    if (!list) return clause;
    const labels = list[1].split(/\s*(?:和|与|及|、)\s*/);
    const values = clause.slice(list.index + list[0].length).split(/\s*(?:和|与|及|、|，)\s*(?=[+-]?\d)/);
    if (values.length !== labels.length) return clause;
    return clause.slice(0, list.index) + labels.map((label, i) => label + ' ' + values[i]).join('，');
  });
}

function* workbookClaims(blocks, items) {
  // Item names are restricted to letters, numbers and spaces by requestedItems.
  const names = '(?:' + items.toSorted((a, b) => b.length - a.length).join('|') + ')';
  const namedValue = new RegExp(String.raw`(${names})\s*(?:约\s*)?(?:为|是|[:：=])?\s*(${NUMBER})(?!\d|\.\d)`, 'g');
  const orderedList = new RegExp(String.raw`(${names}(?:\s*(?:和|与|及|、)\s*${names})+)\s*(?:分别|各自?)\s*(?:为|是)\s*`);
  for (const block of blocks) {
    for (const [row, part] of block.parts.entries()) {
      const plain = part.replace(/[*`]/g, '');
      for (const view of claimViews(block, row, items, orderedList)) {
        // Preserve offsets into the clause when masking sources and column separators.
        const masked = view.replace(new RegExp(LOCATOR_SOURCE, 'g'), ref => ' '.repeat(ref.length));
        const claims = [...(block.header ? masked.replaceAll('|', ' ') : masked).matchAll(namedValue)];
        for (const [i, claim] of claims.entries()) {
          const [, item, reported] = claim;
          const scope = view.slice(i === 0 ? 0 : claim.index, claims[i + 1]?.index);
          const ref = extractLocatorMatches(scope).at(-1);
          const endsWithCitation = ref && /^[)）]?$/.test(scope.slice(ref.index + ref.raw.length).trim()) && plain.endsWith(scope);
          const plainValue = plain.replace(PERIOD_PREFIX, '').replace(/[。.!！]$/, '') === claim[0];
          yield { part, item, value: Number(reported.replaceAll(',', '')), scope,
            explicitSource: Boolean(ref), complete: block.header || endsWithCitation || plainValue };
        }
      }
    }
  }
}

export function workbookItemCoverage(question, blocks, evidence, workbookTurn) {
  const { items, numeric } = requestedItems(question);
  const result = { missing: [], evidenceIds: new Set(), unsupported: new Set(), supported: new Set(), verifiedEndings: new Set() };
  const supportsItem = (cell, item) => cell.metric && typeof cell.value === 'number' &&
    (cell.metric === item || item.endsWith('表' + cell.metric));
  if (!items.length || !workbookTurn) return result;
  // An open-ended list (e.g. advantages and risks) need not contain numbers.
  if (!numeric && !items.some(isWorkbookMetricName) && !evidence.some(cell => items.some(item => supportsItem(cell, item)))) return result;

  const answered = new Set();
  const unsupportedItems = new Set();
  for (const claim of workbookClaims(blocks, items)) {
    const { item, value, part, scope, explicitSource, complete } = claim;
    const cited = explicitSource ? adoptedCitations(scope, evidence) : evidence;
    const sources = cited.filter(cell => supportsItem(cell, item) && cell.value === value);
    if (!sources.length) {
      unsupportedItems.add(item);
      result.unsupported.add(part);
      continue;
    }
    answered.add(item);
    result.supported.add(part);
    for (const cell of sources) result.evidenceIds.add(cell.id);
    if (complete) result.verifiedEndings.add(part);
  }
  result.missing = items.filter(item => !answered.has(item) || unsupportedItems.has(item));
  return result;
}

export function blockingFinding(finding) {
  return finding.severity === 'error' || finding.rule === 'unverified_locator';
}

// On exhaustion or interruption only release complete, separately sourced
// sentences or table rows that pass the same factual checks alone and together.
export function verifiedPortion(blocks, evidenceFor, findingsFor, coverage) {
  const verified = [];
  for (const { header, parts } of blocks) {
    const kept = parts.filter(part => {
      if (coverage.unsupported.has(part) || (coverage.missing.length && !coverage.supported.has(part))) return false;
      const sourced = coverage.verifiedEndings.has(part) ||
        (/[。！？.!?]$/.test(part) && adoptedCitations(part, evidenceFor(part)).length);
      return sourced && !findingsFor(part).some(blockingFinding);
    });
    if (kept.length) verified.push([...(header ? [header] : []), ...kept].join('\n'));
  }
  const body = verified.join('\n\n');
  return body && !findingsFor(body).some(blockingFinding) ? body : '';
}
