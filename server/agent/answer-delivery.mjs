import { isWorkbookMetricName } from '../../lib/workbook-query.mjs';
import { Lexer } from 'marked';
import { citationLookup } from '../../lib/citations.mjs';
import { citationFilenames, citationIdentity, citationQualifiers, extractLocatorMatches, LOCATOR_SOURCE, locatorKey, maskCitationIds, resolveLocatorToken } from '../../lib/citation-locator.mjs';

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
  const idSources = new Set();
  const searchable = maskCitationIds(text, available, cell => { if (cell) idSources.add(cell); });
  for (const match of extractLocatorMatches(searchable)) {
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
  for (const cell of idSources) if (!used.has(cell.id)) adopt(cell);
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
const SOURCE_VERSION = new RegExp(String.raw`(?:(?:材料|文件)(?:的)?\s*)?(?:版本(?:号)?|\bversion)\s*(?:为|是)?\s*[:=]?\s*v?\s*(${VERSION_LABEL})|(?:材料|文件)?第\s*(${VERSION_LABEL})\s*版|(?<!\w)@?v(\d+(?:\.\d+)*)\b`, 'gi');

const PRESENT = /当前|目前|现在|最新|现行|现为|(?:截至|截止|直至|到)?(?:今天|今日|如今)|\b(?:current(?:ly)?|today|now|latest)\b/i;
const SOURCE_CLAUSE_BREAK = new RegExp(String.raw`[；;]|[，,](?=\s*(?:而|但)?(?:同一|该|这份)?(?:材料|文件|工作簿)?(?:${PRESENT.source}))`, 'i');
// Check descriptive fields against the source of the written locator. Keep the
// original answer and its qualifiers intact for lint, delivery and linking.
function checkSourceFields(clause, refs, lookup, precedingSource, ids) {
  const resolved = refs.map(ref => resolveLocatorToken(ref.raw, lookup)?.citation);
  let conflict = '';
  let hasFields = false;
  let idConflict = '';
  let hasId = false;
  function check(segment, source) {
    // Compare to the literal ID of the written source, not a reconstructed
    // ID or a different citation that happened to match the search.
    let text = maskCitationIds(segment, ids, (cited, field) => {
      hasId = true;
      hasFields = true;
      if (!cited || cited.id !== source?.id) idConflict = field;
    }).normalize('NFKC').replace(/^\s*[-•]\s+/, '').replace(/[`*]/g, '');
    const names = citationFilenames(source);
    if (names.length) {
      const alternatives = names.map(name => name.normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length).join('|');
      const nameField = String.raw`(?:(实际存储|存储|实际上传|磁盘|显示|原始)(?:文件)?名(?:称)?|(?:工作簿(?:文件)?|(?:上传)?文件)(?:名(?:称)?)?)\s*(?:为|是|:)?\s*`;
      const ending = String.raw`(?![\w-]|\.[\w.-])`;
      const knownName = String.raw`(?:\[(${alternatives})\]|(${alternatives})${ending})`;
      // At a label, consume the whole written workbook name, including
      // spaces. A later word in “copy of Book.xlsx” cannot identify the file.
      const otherName = String.raw`(?:\[([^\[\]\n]+?\.xls[xm])\]|([^\[\]()，,。；;：:、\n]+?\.xls[xm])${ending})`;
      const labeled = new RegExp(nameField + `(?:${knownName}|${otherName})`, 'g');
      text = text.replace(labeled, (field, kind, bracketed, plain, otherBracketed, otherPlain) => {
        hasFields = true;
        if (otherBracketed || otherPlain) conflict = field;
        else if (kind) {
          const expected = /存储|上传|磁盘/.test(kind) ? source.storedFilename : source.filename;
          if (expected?.normalize('NFKC') !== (bracketed || plain)) conflict = field;
        }
        return ' ';
      });
      // Bare names need a delimiter. Chinese letters and filename characters
      // such as '+' must not turn an unknown name into a known suffix.
      const boundary = String.raw`(?<!\S)|(?=\[)|(?<=[(（,，。;；:：、"“'‘《])`;
      text = text.replace(new RegExp(`(?:${boundary})${knownName}`, 'g'), ' ');
    }
    text = text.replace(/(?:\bSheet|工作表)\s*(?:为|是|:)\s*([^，,;；()]+?)\s*的\s*(\$?[a-z]{1,3}\$?\d+)\s*单元格/gi, (field, sheet, cell) => {
      hasFields = true;
      if (!source || locatorKey(sheet.trim() + '!' + cell) !== locatorKey(source.locator)) conflict = field;
      return ' ';
    });
    const otherWorkbook = text.match(/[^\s()[\]，,。；;]+\.xls[xm]\b/i);
    if (otherWorkbook) conflict = otherWorkbook[0];
    text = text.replace(/(?:材料|文件|material|file)\s*ID\s*(?:为|是)?\s*[:=]?\s*([\w-]+)/gi, (field, id) => {
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
  return { checked, conflict, idConflict, hasId, hasFields, lastSource };
}

// A source-only answer can list fields, or give several spellings of one
// locator. Consume only provenance vocabulary after checking field values. Any
// remaining assertion still needs the usual direct evidence and lint checks.
const SOURCE_WORDS = new RegExp([
  '也就是说|换句话说|换言之|具体来说|也就是|亦即|因此|所以|其中|内容|包括|对应|完整|限定|带有|带',
  '当时|采用|使用|用|历史|本会话|会话|本次|此次|本轮|当轮|原始|原文|正式|已交付|交付|助手|回答|答文|回复|记录',
  '当|若|如果|可能|其他|同名|重名|避免|文件名称|文件名|工作簿|工作表|文件|材料|单元格|坐标|定位',
  '出处|来源|引用|援引|版本号|版本|格式|规范|标准|形式|约定|标识|标注|标记|表示|显示|写作|写为|记作|记为|写法|全称',
  '应当|应该|应|也可|可以|可|以及|及|与|和|这份|该|其|这|那|份|个|按照|依照|遵循|根据|依据|按|即|为|是|的|所|了|中|里|于|在|时',
].join('|'), 'g');
// A verified ID field can also identify the search result that supplied it.
// Interpret those words only in a clause containing a checked ID; keep every
// other assertion for the source and financial checks below.
const SEARCH_TERMS = /transcript_search|命中项?|匹配项?|检索|搜索|查询|工具|结果|返回|提供|给出|携带|附带|所附|条/gi;
const SOURCE_POINTER = /(?:这(?:条|个|一)?|该|其|此|上述|前述)(?:引用|出处|来源|记录)(?:所)?(?:指向|指的(?:是)?|对应(?:于)?)/;
function sourceFieldsOnly(part, hasId) {
  if (hasId) part = part.replace(/(?:由)?[他她它](?:所)?(?=引用|援引|提供|返回|给出|携带)/g, '').replace(SEARCH_TERMS, '');
  return !part.replace(new RegExp(LOCATOR_SOURCE, 'g'), ' ')
    .replace(/第\s*[零一二三四五六七八九十百千\d]+\s*[轮次]/g, '')
    .replace(new RegExp(SOURCE_POINTER.source, 'g'), '')
    .replace(SOURCE_WORDS, '')
    .replace(/[\s。，；、,.!:：;!？?()（）“”「」`*]/g, '');
}

const ALTERNATE_SPELLING = /(?:写作|写为|记作|记为|表示为)\s*[:：]?\s*$/;
const RESTATEMENT = /也就是说|也就是|换句话说|换言之|亦即|(?:写作|写为|记作|记为|表示为)\s*[:：]?\s*$/;
function reportsHistoricalSource(part, refs, question, hasId) {
  let description = part.replace(new RegExp(LOCATOR_SOURCE, 'g'), ' ');
  const historicalSubject = HISTORY.test(description);
  description = description.replace(/第\s*\d+\s*[轮次]|\bturn\s*#?\d+|\d+\s*条(?=\s*(?:命中|记录|结果|[，,。；;]|$))/gi, ' ');
  if (/\d|当前|现在|最新|现价|[零〇一二两三四五六七八九十百千万亿]+(?:元|美元|港元|%)|\b(?:current|now|latest)\b/i.test(description)) return false;
  const provenanceQuestion = HISTORY.test(question) && REFERENCE.test(question);
  if ((historicalSubject || provenanceQuestion) && sourceFieldsOnly(part, hasId)) return true;
  if (provenanceQuestion && SOURCE_ONLY.test(description.trim())) return true;
  if (!historicalSubject && !(HISTORY.test(question) && /回[答复]|答[文复案]|\b(?:reply|answer)\b/i.test(description))) return false;
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
      ALTERNATE_SPELLING.test(prefix)) && sourceTail) || sourceFirst;
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

function assertsCurrentVersion(description) {
  const time = PRESENT.exec(description);
  if (!time) return false;
  return [...description.matchAll(SOURCE_VERSION)].some(({ index }) => {
    const prefix = description.slice(0, index);
    if (/(?:无法|不能|尚未|未能)(?:核实|核验|确认|确定)(?:为|是)?\s*$/u.test(prefix)) return false;
    // “Today I found the first answer cited …” dates the search. The
    // historical subject between that time and the version owns the field.
    if (index >= time.index) return !HISTORY.test(description.slice(time.index + time[0].length, index));
    return !HISTORY.test(description.slice(0, time.index));
  });
}

// Resolve the subject of a current-version statement to one material and one
// version actually read this turn. Another cell in that workbook also proves
// its version. A search hit or a rehydrated ledger entry cannot do so.
function currentWorkbookEvidence(refs, implicitMaterials, reads) {
  const lookup = citationLookup(reads);
  const owners = refs.length ? refs.map(ref => resolveLocatorToken(ref.raw, lookup)?.citation?.materialId) : implicitMaterials;
  if (new Set(owners).size !== 1) return [];
  const materialReads = reads.filter(cell => cell.materialId === owners[0]);
  return new Set(materialReads.map(cell => cell.version)).size === 1 ? materialReads : [];
}

// A source description can list the workbook and version before naming its
// cell, with a field per line or per semicolon. Stop at unrelated prose.
function followingSourceLocator(restOfSentence, parts, nextPart, ids) {
  let text = restOfSentence;
  for (;;) {
    const ref = extractLocatorMatches(maskCitationIds(text, ids))[0];
    if (ref) return ref;
    if (nextPart >= parts.length || (text && !/材料|工作簿|文件|版本|引用|\.xlsx?\b|\b(?:material|version|citation)\b/i.test(text))) return null;
    text = parts[nextPart++];
  }
}

export function reportedLocatorEvidence(text, question, current, matches, workbookEvidence = []) {
  const fallback = { citations: current };
  if (!matches.length && !(HISTORY.test(question) && REFERENCE.test(question))) return fallback;
  const requested = explicitTurns(question);
  const allowed = matches.filter(match => !requested.size || requested.has(match.turn));
  const used = new Map();
  const bindings = [];
  let hasHistoricalLink = false;
  let precedingSource;
  let lastMaterials;
  for (const { parts } of answerBlocks(text)) {
    for (const [partIndex, part] of parts.entries()) {
      const reported = explicitTurns(part);
      const cells = allowed.filter(match => !reported.size || reported.has(match.turn)).flatMap(match => match.citations);
      const historyLookup = citationLookup(cells);
      const ids = [...cells, ...current];
      const clauses = part.split(SOURCE_CLAUSE_BREAK);
      for (const [i, clause] of clauses.entries()) {
        const masked = maskCitationIds(clause, ids);
        const refs = extractLocatorMatches(masked);
        const description = masked.replace(new RegExp(LOCATOR_SOURCE, 'g'), ' ').normalize('NFKC');
        const presentVersion = assertsCurrentVersion(description);
        const scope = presentVersion
          ? currentWorkbookEvidence(refs, lastMaterials ?? cells.map(cell => cell.materialId), workbookEvidence)
          : cells;
        if (presentVersion && !scope.length) return { citations: [], conflict: clause };
        const fieldLookup = presentVersion ? citationLookup(scope) : historyLookup;
        let noteSource = presentVersion ? scope[0] : precedingSource;
        if (!refs.length && !noteSource) {
          // A standalone version or ID may also introduce the next source.
          if (!REFERENCE.test(question)) continue;
          const nextRef = followingSourceLocator(clauses.slice(i + 1).join('；'), parts, partIndex + 1, ids);
          if (!nextRef) continue;
          noteSource = resolveLocatorToken(nextRef.raw, historyLookup)?.citation;
        }
        const fields = checkSourceFields(clause, refs, fieldLookup, noteSource, ids);
        if (presentVersion && fields.conflict) return { citations: [], conflict: fields.conflict };
        if (!refs.length) {
          if (fields.idConflict) return { citations: [], conflict: fields.idConflict };
          // Only an adjacent source note can qualify the preceding citation.
          const noteOnly = sourceFieldsOnly(fields.checked, fields.hasId);
          const describesPresent = PRESENT.test(description) && !HISTORY.test(description);
          const sourceNote = !describesPresent && (/材料|文件|工作簿|版本|引用记录|material|file|version/i.test(clause) ||
            (fields.hasFields && (HISTORY.test(clause) || noteOnly)));
          if (fields.conflict && sourceNote) return { citations: [], conflict: fields.conflict };
          // A financial gloss can follow a source report after a full stop.
          // The historical hit cannot stand in for a direct read of that cell.
          const financial = /数值|常量|读数|期间|单位|收入|营收|利润|金额|增长|下降/.test(fields.checked);
          if (presentVersion && financial) {
            // The metadata alone does not verify an appended financial value.
            const values = fields.checked.match(/[+-]?\d+(?:,\d{3})*(?:\.\d+)?/g) || [];
            if (values.some(value => !scope.some(cell => cell.value != null &&
              Number(cell.value) === Number(value.replaceAll(',', ''))))) return { citations: [], conflict: clause };
          }
          const cellClaim = financial && /^(?:对应|其|该|这|上述|前述)/.test(clause.trim());
          if (cellClaim && precedingSource && !current.some(cell => citationIdentity(cell) === citationIdentity(precedingSource) &&
            locatorKey(cell.locator) === locatorKey(precedingSource.locator))) return { citations: [], conflict: clause };
          if (((i && !describesPresent) || (sourceNote && fields.hasFields)) && !noteOnly) {
            return { citations: [], conflict: clause };
          }
          if (!sourceNote) precedingSource = undefined;
          continue;
        }
        const checkedRefs = extractLocatorMatches(fields.checked);
        const isReport = !presentVersion && reportsHistoricalSource(fields.checked, checkedRefs, question, fields.hasId);
        // A restatement must name the same material, version and cell as its
        // antecedent, even if both locators occurred in the search results.
        let antecedent = precedingSource;
        let start = 0;
        for (const ref of checkedRefs) {
          const prefix = fields.checked.slice(start, ref.index);
          const source = resolveLocatorToken(ref.raw, historyLookup)?.citation;
          if (isReport && antecedent && (SOURCE_POINTER.test(prefix) || RESTATEMENT.test(prefix)) && (!source ||
              citationIdentity(source) !== citationIdentity(antecedent) ||
              locatorKey(source.locator) !== locatorKey(antecedent.locator))) {
            return { citations: [], conflict: ref.raw };
          }
          antecedent = source;
          start = ref.index + ref.raw.length;
        }
        // Resolve historical prose solely against the cited turn. A current
        // reading of the same coordinate can belong to a different version.
        const evidence = isReport ? cells : current;
        const lookup = isReport ? historyLookup : citationLookup(current);
        const idConflict = fields.hasId && !isReport
          ? checkSourceFields(clause, refs, lookup, undefined, ids).idConflict : fields.idConflict;
        if (idConflict) return { citations: [], conflict: idConflict };
        if (isReport && fields.conflict) return { citations: [], conflict: fields.conflict };
        lastMaterials = [];
        for (const { raw } of refs) {
          const source = resolveLocatorToken(raw, lookup)?.citation;
          if (!source) return isReport ? { citations: [], conflict: raw } : { citations: [] };
          bindings.push({ raw, identity: citationIdentity(source) });
          lastMaterials.push(source.materialId);
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
  // A fully verified source report may end in a literal ID field. An actual
  // length stop or another unfinished construct still goes through continuation.
  let endsWithIdField = false;
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  maskCitationIds(lastLine, citations, (cell, field) => {
    if (cell && lastLine.endsWith(field) && (field !== cell.id || lastLine.trim() === field)) endsWithIdField = true;
  });
  return { citations, endsWithIdField };
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
