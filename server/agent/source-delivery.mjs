import {Lexer} from 'marked';
import {
  citationFilenames,
  citationLookup,
  extractLocatorMatches,
  maskCitationIds,
  resolveLocatorToken,
} from '../../lib/citation-locator.mjs';
import {
  adoptedCitations,
  answerBlocks,
  blockingFinding,
  checkSourceFields,
  explicitTurns,
  reportedLocatorEvidence,
  sourceFieldsOnly,
} from './answer-delivery.mjs';
import {resultReports} from './transcript-search-recovery.mjs';
import {conditionValue} from './source-observations.mjs';
import {digest} from './source-plan.mjs';

const absent =
  /(?:未(?:命中|匹配|引用|找到|检索到|查到)|没有(?:命中|匹配|引用|找到)|无(?:匹配|命中)|零命中|0\s*条|no matches)/i;
const negative = /并非|并不|不是|绝非|不曾|并未|没有引用|未曾引用|\bnot\b|\bnever\b/i;
const now = /当前|截至今天|目前|今天|现在|最新|本次读取|本轮(?:直接读取|实读)|\bcurrent(?:ly)?\b|\btoday\b/i;
const amount = /(?:利润|收入|增长|营收|财务|常量|读数|金额|数值|值为|余额|同比|环比|元\/股|万元|亿元|百万元)/;
const version =
  /(?:\bv|@v)\d+\b|第[一二三四五六七八九十\d]+版|(?:版本|\bversion)\s*(?:为|是|[:：])?\s*v?\d+/i;
const unsafeMarkdown = /<[^>]+>|!?\[[^\]\n]*\]\s*\([^)\n]*\)|^\s*\[[^\]\n]+\]:/;

// Only tokens which actually render as text can satisfy an explicit field.
function visibleMarkdown(markdown) {
  function leaves(tokens) {
    return tokens
      .map((t) => {
        if (['html', 'image', 'def', 'space'].includes(t.type)) return '';
        if (t.type === 'table')
          return leaves([...t.header, ...t.rows.flat()].map((c) => ({tokens: c.tokens})));
        if (t.items) return leaves(t.items);
        return t.tokens ? leaves(t.tokens) : (t.text ?? '');
      })
      .join('\n');
  }
  return leaves(Lexer.lex(markdown));
}

function units(text) {
  const result = [];
  let end = 0;
  for (const block of answerBlocks(text))
    for (const value of block.parts) {
      const start = text.indexOf(value, end);
      if (start < 0) continue;
      end = start + value.length;
      result.push({value, start, end});
    }
  return result;
}

// A blind reader can align several field labels to a list of values. Verify
// each literal against the same witness before trusting that alignment. The
// remaining text cannot contain a second identity, number, version or cell.
function alignedFieldList(unit, claim, source, conflict) {
  if (
    !conflict ||
    !source ||
    claim?.relation !== 'historical' ||
    claim.polarity !== 'positive' ||
    !claim.fields?.length ||
    /(?:第[^，。；：\s]{1,8}版|\bnot\b|否定|作废)/iu.test(unit)
  )
    return false;
  let residue = unit.normalize('NFKC');
  const values = {
    filename: citationFilenames(source),
    storedFilename: [source.storedFilename],
    displayFilename: [source.filename],
    materialId: [source.materialId],
    version: ['v' + source.version, String(source.version)],
    id: [source.id],
    locator: [source.locator],
  };
  const ordered = [...claim.fields].sort((a, b) => String(b.literal).length - String(a.literal).length);
  const overlap = ordered.some((f) => typeof f.literal === 'string' && conflict.includes(f.literal));
  if (!overlap) return false;
  for (const f of ordered) {
    if (typeof f.literal !== 'string' || !values[f.name]?.includes(f.literal)) return false;
    const pos = residue.indexOf(f.literal);
    if (pos < 0) return false;
    if (
      ['filename', 'displayFilename', 'storedFilename', 'materialId', 'version', 'id'].includes(f.name) &&
      pos &&
      /[\w.\-]/.test(residue[pos - 1])
    )
      return false;
    residue = residue.slice(0, pos) + ' '.repeat(f.literal.length) + residue.slice(pos + f.literal.length);
  }
  if (
    /存储|磁盘|storedFilename/i.test(unit) &&
    !ordered.some((f) => f.name === 'storedFilename' && f.literal === source.storedFilename)
  )
    return false;
  if (
    /显示名|原始名|displayFilename/i.test(unit) &&
    !ordered.some((f) => f.name === 'displayFilename' && f.literal === source.filename)
  )
    return false;
  if (
    /(?:版本|version)\s*[:=]\s*[\da-f]{8}-/i.test(conflict) &&
    !(
      ordered.some((f) => f.name === 'materialId') &&
      ordered.some((f) => f.name === 'version') &&
      /材料|material/i.test(unit)
    )
  )
    return false;
  return !/[\d!@]|\.xls[xm]|cite:|第[^，。；]{1,8}版/i.test(residue);
}

// Counts concern the successful scan in the requested scope. An omitted
// model projection, an unrestricted query or an incomplete scan proves none.
function executionReport(claim, text, owners, observations) {
  if (
    claim?.relation !== 'execution' ||
    !claim.fields?.length ||
    extractLocatorMatches(text).length ||
    /cite:|\.xls[xm]|@v\d|\bv\d/i.test(text)
  )
    return;
  const attempts = observations.attempts.filter(
    (a) =>
      a.state === 'success' &&
      a.name === 'transcript_search' &&
      owners.every((i) => i.attemptIds.includes(a.id)),
  );
  for (const attempt of attempts) {
    const d = attempt.details,
      coverage = d?.coverage;
    if (
      !coverage ||
      coverage.truncated !== false ||
      !Array.isArray(d.matches) ||
      d.totalMatches !== d.matches.length
    )
      continue;
    const hits = d.matches.filter((m) => m.role === 'assistant');
    // A whole-scan count and a count for one workbook or turn are equal
    // only when all returned rows lie in the selected scope.
    if (
      hits.some((m) =>
        owners.some(
          (i) =>
            (i.turn && i.turn !== m.turn) ||
            (i.book && !(m.citations ?? []).length) ||
            (i.book && m.citations.some((c) => !citationFilenames(c).includes(i.book))),
        ),
      )
    )
      continue;
    const ids = hits.flatMap((h) => (h.citations ?? []).map((c) => c.id));
    const values = {
      assistantMatches: hits.length,
      totalTurns: coverage.totalTurns,
      turnsScanned: coverage.turnsScanned,
      scannedTurn: coverage.turns?.length === 1 ? coverage.turns[0] : undefined,
      ledgerMatches: d.ledgerTotalMatches,
      truncated: false,
    };
    if (observations.historyToolsOnly) values.directReadCount = 0;
    if (hits.length === 1) {
      const h = hits[0];
      values.sourceStatus = h.sourceStatus;
      values.sourceTurnId = h.sourceTurnId;
      if (h.sourceTurnId && Array.isArray(h.sourceLimits)) values.limitCount = h.sourceLimits.length;
      if (
        h.sourceTurnId &&
        !h.sourceDigest &&
        ids.length &&
        ids.every((id) => observations.witnesses.some((w) => w.callId === attempt.id && w.citation.id === id))
      )
        values.citationCount = new Set(ids).size;
    }
    const corroborated = (f) => {
      if (
        typeof f.literal !== 'string' ||
        !f.literal.trim() ||
        !text.includes(f.literal) ||
        !Object.hasOwn(values, f.name) ||
        values[f.name] === undefined
      )
        return false;
      const expected = values[f.name];
      const statusNames = {
        completed: '已完成',
        partial: '部分完成',
        failed: '失败',
        cancelled: '已取消',
        unknown: '未知',
      };
      const literal = f.literal;
      // The JSON reader can serialize a scalar as text. Compare it using
      // the type of the durable observation and verify its visible spelling.
      const value = String(f.value);
      if (value !== String(expected) && !(f.name === 'sourceStatus' && value === statusNames[expected]))
        return false;
      if (typeof expected === 'number') {
        const digits = f.literal.match(/\d+/g) ?? [];
        if (digits.length) return digits.every((n) => Number(n) === expected);
        if (expected === 0) return /未|没有|无|零|未曾/.test(f.literal);
        return (
          Number.isInteger(expected) &&
          expected > 0 &&
          expected < 10 &&
          f.literal.includes('零一二三四五六七八九'[expected])
        );
      }
      if (typeof expected === 'boolean')
        return (
          f.literal.includes(String(expected)) || (expected === false && /未截断|没有截断/.test(f.literal))
        );
      return (
        typeof expected === 'string' &&
        (literal.includes(expected) || (f.name === 'sourceStatus' && literal.includes(statusNames[expected])))
      );
    };
    if (!claim.fields.every(corroborated)) continue;
    let unchecked = text;
    for (const field of [...claim.fields].sort((a, b) => b.literal.length - a.literal.length)) {
      unchecked = unchecked.replace(field.literal, ' ');
    }
    unchecked = unchecked.replace(/第\s*(\d+)\s*轮/g, (token, n) =>
      coverage.turns?.length === 1 && coverage.turns[0] === Number(n) ? ' ' : token,
    );
    if (!/[\da-f]{8}-[\da-f-]{27}|\d|\.xlsx|cite:/i.test(unchecked)) return attempt;
  }
}

function distinctWitnesses(witnesses) {
  return [...new Map(witnesses.map((w) => [w.citation.id, w])).values()];
}

// A budget stop can precede the first printable draft even though the
// requested source was retrieved. Recover only a fully enumerated, unique
// source and submit the resulting text to the ordinary field verifier.
export function recoverSourceFields(plan, observations) {
  if (
    plan.route !== 'history' ||
    plan.research ||
    plan.gaps.length ||
    plan.items.length !== 1 ||
    observations.recoveryGaps.length ||
    observations.badIds.length
  )
    return;
  const [item] = observations.items;
  if (!item || item.item.action !== 'search' || item.item.operation !== 'source' || !item.item.turn) return;
  const sources = distinctWitnesses(item.hits);
  if (sources.length !== 1) return;
  const w = sources[0],
    c = w.citation;
  const attempt = observations.attempts.find((a) => a.id === w.callId);
  const d = attempt?.details;
  if (
    !w.sourceTurnId ||
    !d?.coverage ||
    d.coverage.truncated !== false ||
    !d.coverage.turns?.includes(item.item.turn) ||
    d.matches?.length !== d.totalMatches ||
    d.matches.filter((m) => m.role === 'assistant').length !== 1
  )
    return;
  // Use plain representable identifiers. The workbook and cell stay on the
  // original version even when the catalogue now has a newer head.
  if (
    !/^[\p{L}\p{N}_. -]+\.xls[xm]$/u.test(c.filename ?? '') ||
    !/^[\p{L}\p{N}_ -]+!\$?[A-Z]{1,3}\$?\d+$/u.test(c.locator ?? '') ||
    !/^[\da-f-]{36}$/i.test(c.materialId ?? '') ||
    c.id !== 'cite:' + c.materialId + ':v' + c.version + ':' + c.locator
  )
    return;
  return (
    '第' +
    w.turn +
    '轮正式回答引用的是 [' +
    c.filename +
    ']' +
    c.locator +
    '（材料 ID ' +
    c.materialId +
    '，版本 v' +
    c.version +
    '）。\n\n完整引用 ID：' +
    c.id
  );
}

export function evaluateSourceDraft({
  text,
  question,
  plan,
  observations,
  currentVersions,
  meaning,
  lint,
  review,
  repairId = true,
}) {
  const {items: observed, witnesses, badIds} = observations;
  const decisions = observed.map(({item, hits, related, empty, attemptIds}) => ({
    ...item,
    hits,
    related,
    empty,
    attemptIds,
    state: 'unresolved',
    delivered: new Set(),
  }));
  const readItem = plan.items.find((i) => i.action === 'read');
  const currentDecision = readItem && {
    ...readItem,
    state: 'unresolved',
    attemptIds: [],
    delivered: new Set(),
  };
  if (currentDecision) {
    if (readItem.conditional) {
      const value = conditionValue(readItem.predicate, observed);
      currentDecision.condition = value ?? 'unknown';
      if (value === false) currentDecision.state = 'notApplicable';
    }
  }
  const allHist = distinctWitnesses(decisions.flatMap((i) => i.hits));
  const ids = new Set(allHist.map((w) => w.citation.materialId));
  const direct = distinctWitnesses(
    witnesses.filter(
      (w) =>
        w.relation === 'read' &&
        w.selection === 'head' &&
        ids.has(w.citation.materialId) &&
        currentVersions[w.citation.materialId] === w.citation.version,
    ),
  );
  const reviewItem = plan.items.find((i) => i.action === 'review');
  const reviewed = reviewItem && {...reviewItem, state: 'unresolved', delivered: new Set(), attemptIds: []};
  const optionalRead = {
    id: 'observed-read',
    action: 'read',
    fields: [],
    delivered: new Set(),
    attemptIds: [],
    state: 'answered',
  };
  const claims = [],
    occurrences = [],
    rejected = [],
    optionalNotes = [],
    rejectedChecks = [],
    citations = new Map();
  let body = '',
    priorEnd = 0,
    antecedent;
  const accept = (unit, refs, owners, ws, relation) => {
    if (body) {
      const separator = text.slice(priorEnd, unit.start);
      body += /^\s*$/.test(separator) ? separator : '\n';
    }
    const offset = body.length;
    body += unit.value;
    priorEnd = unit.end;
    const itemIds = owners.map((item) => item.id);
    claims.push({
      start: offset,
      end: body.length,
      relation,
      itemIds,
      citationIds: [...new Set(ws.map((w) => w.citation?.id).filter(Boolean))],
      callIds: [...new Set(ws.map((w) => w.callId))],
      sourceTurns: [...new Set(ws.map((w) => w.sourceTurnId ?? w.legacyAnchor).filter(Boolean))],
    });
    for (const {raw, index, citation} of refs) {
      citations.set(citation.id, citation);
      occurrences.push({
        start: offset + index,
        end: offset + index + raw.length,
        text: raw,
        citationId: citation.id,
      });
    }
  };
  const gaps = [...plan.gaps, ...observations.recoveryGaps];
  for (const unit of units(text)) {
    const s = unit.value,
      visible = visibleMarkdown(s);
    const ledgerCount = s.match(/台账.*?(?:记录|命中).*?(\d+)\s*条/);
    if (ledgerCount) {
      const proof = observations.attempts.find(
        (c) =>
          c.name === 'transcript_search' &&
          c.state === 'success' &&
          c.details?.ledgerTotalMatches === Number(ledgerCount[1]),
      );
      if (proof && !amount.test(s.replace('字面常量', '')))
        accept(unit, [], [], [{callId: proof.id}], 'ledgerCount');
      else rejected.push(s);
      continue;
    }
    const named = decisions.filter((i) => i.query && s.toLowerCase().includes(i.query.toLowerCase()));
    const selected = named.length ? named : decisions;
    if (/^(?:[-*] )?未核验[：:]/.test(s) && !/^未核验[：:]\s*无[。.]?$/.test(s)) {
      gaps.push(s);
      continue;
    }
    const visibleUnit = visible.trim();
    const semantics =
      meaning?.claims?.filter((c) => {
        if (typeof c.quote !== 'string' || !c.quote.trim()) return false;
        const quote = visibleMarkdown(c.quote).trim();
        return s.includes(c.quote) || (quote && visibleUnit.includes(quote));
      }) ?? [];
    const whole = semantics.find((c) => c.quote === s || visibleMarkdown(c.quote).trim() === visibleUnit);
    const executionClaims = semantics.filter((c) => c.relation === 'execution');
    const completeExecution =
      executionClaims.length &&
      executionClaims.length === semantics.length &&
      (whole ||
        !executionClaims
          .reduce((rest, c) => rest.replace(c.quote, ''), s)
          .replace(/[\s。，、；;,.：:]/g, ''));
    if (completeExecution) {
      const evidence = {relation: 'execution', fields: executionClaims.flatMap((c) => c.fields ?? [])};
      const attempt = executionReport(evidence, s, selected, observations);
      if (attempt) accept(unit, [], selected, [{callId: attempt.id}], 'execution');
      else if (
        plan.route === 'history' &&
        decisions.every((i) => i.operation === 'source') &&
        !/覆盖|扫描|台账|是否截断|工具过程|检索过程/.test(question) &&
        !extractLocatorMatches(s).length &&
        !/\.xls[xm]|cite:|@v\d|\bv\d/i.test(s)
      )
        optionalNotes.push(s);
      else rejected.push(s);
      continue;
    }
    if (
      whole?.relation === 'scope' &&
      !extractLocatorMatches(s).length &&
      !version.test(s) &&
      !/[\d%]/.test(s.replace(/第\s*\d+\s*轮/g, '')) &&
      !(whole.fields ?? []).length
    ) {
      accept(unit, [], [], [], 'scope');
      continue;
    }
    if (
      selected.some((i) => i.hits.length) &&
      /[:：]\s*$/.test(s) &&
      whole?.relation === 'historical' &&
      whole.polarity === 'positive' &&
      !extractLocatorMatches(s).length &&
      [...explicitTurns(s)].every((round) => selected.some((i) => i.hits.some((w) => w.turn === round))) &&
      selected.every((i) => i.hits.length) &&
      !s.includes('cite:') &&
      !(whole.fields ?? []).some((f) => !['turn', 'query'].includes(f.name))
    ) {
      accept(unit, [], selected, [], 'introduction');
      continue;
    }
    const notes = resultReports(
      [s],
      decisions.map((i) => ({query: i.query || '\u0000'})),
      () => false,
    );
    if (notes.length && !extractLocatorMatches(s).length) {
      const owners = notes.map((n) =>
        decisions.find((i) => (i.query || '\u0000') === n.query && (!n.turns.size || n.turns.has(i.turn))),
      );
      const proven = notes.every(
        (n, k) =>
          n.complete &&
          owners[k] &&
          (n.absent ? owners[k].empty && !owners[k].hits.length : owners[k].hits.length),
      );
      if (!proven) {
        rejected.push(s);
        continue;
      }
      for (const [k, n] of notes.entries()) {
        if (n.absent) owners[k].state = 'confirmedEmpty';
        owners[k].delivered.add(n.absent ? 'absence' : 'presence');
      }
      accept(
        unit,
        [],
        owners,
        owners.flatMap((i) => (i.empty ? [{callId: i.empty}] : i.hits)),
        'searchResult',
      );
      continue;
    }
    if (absent.test(s) && !extractLocatorMatches(s).length) {
      const emptyOwners = selected.filter((i) => i.empty && !i.hits.length);
      if (
        emptyOwners.length &&
        emptyOwners.length === selected.length &&
        (named.length || selected.length === 1)
      ) {
        emptyOwners.forEach((i) => {
          i.state = 'confirmedEmpty';
          i.delivered.add('absence');
        });
        accept(
          unit,
          [],
          emptyOwners,
          emptyOwners.map((i) => ({callId: i.empty})),
          'absent',
        );
      } else rejected.push(s);
      continue;
    }
    // A list introduction has no independent fact. Carry it with the
    // following list only when the list supplies an admissible witness.
    if (
      selected.some((i) => i.hits.length) &&
      /^[-*] /m.test(text.slice(unit.end).trimStart()) &&
      sourceFieldsOnly(s.replace(/如下[：:。.]?$/, ''), false)
    ) {
      accept(unit, [], selected, [], 'introduction');
      continue;
    }
    if (/^未核验[：:]\s*无[。.]?$/.test(s)) {
      if (body) accept(unit, [], [], [], 'qualification');
      continue;
    }
    const isRead =
      semantics.some((c) => c.relation === 'current') || (now.test(s) && !/今天(?:检索|查[询到])/.test(s));
    if (
      isRead &&
      currentDecision &&
      !direct.length &&
      /^(?:当前|目前)(?:材料)?版本(?:尚)?(?:无法|不能|未能)(?:核实|确认)(?:为\s*v?\d+)?[。.]?$/i.test(s)
    ) {
      currentDecision.delivered.add('limitation');
      accept(unit, [], [currentDecision], [], 'limitation');
      continue;
    }
    const rounds = explicitTurns(s);
    const sourcesFor = (i) => (named.length ? i.hits : [...i.hits, ...i.related]);
    const eligible = isRead
      ? direct
      : distinctWitnesses(
          selected.flatMap((i) => sourcesFor(i).filter((w) => !rounds.size || rounds.has(w.turn))),
        );
    const available = eligible.map((w) => w.citation);
    const explicitIds = [];
    maskCitationIds(s, available, (c) => {
      if (c) explicitIds.push(c.id);
    });
    // A literal returned ID can resolve one otherwise ambiguous spelling in
    // this assertion. A second written locator still needs its own witness.
    const allNames = citationLookup(available);
    const hasAmbiguous = extractLocatorMatches(maskCitationIds(s, available)).some(
      (ref) => !resolveLocatorToken(ref.raw, allNames)?.citation && allNames.isAmbiguous(ref.key),
    );
    const pool =
      explicitIds.length === 1 && hasAmbiguous ? available.filter((c) => c.id === explicitIds[0]) : available;
    const lookup = citationLookup(pool);
    const literals = [];
    let invalidId = false;
    const masked = maskCitationIds(s, pool, (c) => {
      if (c) literals.push(c.id);
      else invalidId = true;
    });
    const rawRefs = extractLocatorMatches(masked);
    const adopted = adoptedCitations(s, pool);
    const refs = rawRefs.map((r) => {
      const citation = resolveLocatorToken(r.raw, lookup)?.citation;
      return {...r, citation: adopted.find((c) => c.id === citation?.id) ?? citation};
    });
    const names = pool.filter((c) => citationFilenames(c).some((f) => visible.includes(f)));
    let fieldOwner =
      refs.at(-1)?.citation ||
      pool.find((c) => literals.includes(c.id)) ||
      (pool.some((c) => c.id === antecedent?.id) ? antecedent : undefined) ||
      (pool.length === 1 ? pool[0] : undefined);
    let wrongQualifier = false;
    const fieldText = s.replace(/\[([^\]\n]+)@v(\d+)\](?![\w'$])/gi, (token, name, v) => {
      const sources = pool.filter(
        (c) => c.version === Number(v) && [c.materialId, ...citationFilenames(c)].includes(name),
      );
      if (!sources.length || !sources.some((c) => c.id === fieldOwner?.id)) wrongQualifier = true;
      return ' '.repeat(token.length);
    });
    const fields = checkSourceFields(fieldText, rawRefs, lookup, fieldOwner, pool);
    const exact = refs.every((r) => r.citation && visible.includes(r.raw));
    const reviewedAssertion =
      reviewed &&
      review?.digest === digest(text) &&
      !review.reviewUnavailable &&
      !review.openFindings?.some((f) => f.excerpt && s.includes(f.excerpt)) &&
      (!reviewed.requiresSave || (review.written && !review.pending?.length)) &&
      whole?.relation === 'financial' &&
      whole.polarity === 'positive';
    if (reviewedAssertion) {
      const support = witnesses.filter(
        (w) =>
          w.relation === 'read' &&
          rawRefs.some((r) => resolveLocatorToken(r.raw, citationLookup([w.citation]))?.citation),
      );
      const receipts = distinctWitnesses(support).map((w) => w.citation);
      const typed = checkSourceFields(s, rawRefs, citationLookup(receipts), receipts[0], receipts);
      const targets = rawRefs.map((r) => ({
        ...r,
        citation: resolveLocatorToken(r.raw, citationLookup(receipts))?.citation,
      }));
      if (
        targets.length &&
        targets.every((r) => r.citation && visible.includes(r.raw)) &&
        !typed.conflict &&
        !typed.idConflict &&
        !(lint?.(s, receipts) ?? []).some(blockingFinding)
      ) {
        reviewed.state = 'answered';
        reviewed.delivered.add('reviewedAnswer');
        reviewed.attemptIds = support.map((w) => w.callId);
        accept(unit, targets, [reviewed], support, 'reviewedRead');
        continue;
      }
    }
    const contradicted =
      negative.test(masked) ||
      semantics.some((c) => c.polarity !== 'positive' || !['historical', 'current'].includes(c.relation)) ||
      badIds.some((id) => s.includes(id)) ||
      wrongQualifier ||
      invalidId ||
      (fields.conflict && !alignedFieldList(s, whole, fieldOwner, fields.conflict)) ||
      fields.idConflict;
    const legacy = reportedLocatorEvidence(
      s,
      question,
      direct.map((w) => w.citation),
      (isRead ? allHist : eligible)
        .filter((w) => w.relation === 'historical' && (isRead || pool.some((c) => c.id === w.citation.id)))
        .map((w) => ({turn: w.turn, citations: [w.citation]})),
      direct.map((w) => w.citation),
    );
    const semanticSource =
      semantics.length &&
      semantics.every(
        (c) => c.relation === (isRead ? 'current' : 'historical') && c.polarity === 'positive',
      ) &&
      semantics.some((c) => c.quote === s || visibleMarkdown(c.quote).trim() === visibleUnit);
    const literalProof = literals.length && literals.every((id) => visible.includes(id));
    const proof = !!fieldOwner && (refs.length || fields.hasFields || literalProof || names.length);
    const factualText = named.reduce((part, item) => part.replaceAll(item.query, ''), masked);
    const financial = amount.test(factualText);
    const positiveScope =
      semantics.length &&
      semantics.every((c) => c.relation === (isRead ? 'current' : 'historical') && c.polarity === 'positive');
    const checkedBody = fields.checked.replace(/^\s*[-*]\s+/gm, '');
    const qualifiedOnly = sourceFieldsOnly(checkedBody, fields.hasId);
    const described = meaning
      ? semanticSource || (positiveScope && !legacy.conflict) || qualifiedOnly
      : (literalProof && !refs.length && qualifiedOnly) ||
        (!legacy.conflict &&
          (qualifiedOnly ||
            legacy.historical?.length ||
            (isRead && (legacy.citations?.length || (fields.hasFields && !financial)))));
    let valid = proof && exact && !contradicted && !unsafeMarkdown.test(s) && described;
    if (
      [...visible.matchAll(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi)].some(
        (m) => !pool.some((c) => c.materialId === m[0]) && !eligible.some((w) => w.sourceTurnId === m[0]),
      )
    )
      valid = false;
    if (
      financial &&
      !isRead &&
      /[\d%]|涨|降/.test(
        extractLocatorMatches(fields.checked).reduceRight(
          (part, ref) => part.slice(0, ref.index) + part.slice(ref.index + ref.raw.length),
          fields.checked,
        ),
      )
    )
      valid = false;
    const writtenValue = visible
      .match(/(?:读数|数值|原始值|值)\s*(?:为|是|[:：])?\s*([-+\d,.]+)/)?.[1]
      ?.replaceAll(',', '');
    if (
      isRead &&
      financial &&
      !eligible.some((w) => w.citation.value != null && writtenValue === String(w.citation.value))
    )
      valid = false;
    if (
      isRead &&
      (!eligible.length ||
        (currentDecision?.conditional && currentDecision.condition !== true) ||
        (!currentDecision && /不重报读数|只问历史出处/.test(question)))
    )
      valid = false;
    const findings = lint?.(s, pool) ?? [];
    if (findings.some((f) => blockingFinding(f) && f.rule !== 'incomplete')) valid = false;
    if (!valid) {
      rejectedChecks.push({
        start: unit.start,
        end: unit.end,
        claims: semantics.map((c) => c.relation),
        relation: isRead ? 'current' : 'historical',
        eligible: eligible.map((w) => [w.callId, w.citation.id]),
        condition: currentDecision?.condition,
        proof: Boolean(proof),
        exact,
        contradicted,
        described: Boolean(described),
        findings: findings.filter(blockingFinding).map(({rule, code, message}) => ({rule, code, message})),
      });
      rejected.push(s);
      antecedent = undefined;
      continue;
    }
    const touched = new Set([...refs.map((r) => r.citation.id), ...literals]);
    if (!touched.size) touched.add(fieldOwner.id);
    const matches = eligible.filter((w) => touched.has(w.citation.id));
    const answering = selected.filter((i) => i.hits.some((w) => touched.has(w.citation.id)));
    const owners = isRead
      ? [currentDecision ?? optionalRead]
      : answering.length
        ? answering
        : selected.filter((i) => sourcesFor(i).some((w) => touched.has(w.citation.id)));
    if (!owners.length) {
      rejected.push(s);
      continue;
    }
    for (const i of owners) {
      if (refs.length) i.delivered.add('locator');
      if (version.test(masked)) i.delivered.add('version');
      if (names.length) i.delivered.add('filename');
      if (literalProof) i.delivered.add('id');
      if (isRead) {
        i.attemptIds = [...new Set([...i.attemptIds, ...matches.map((w) => w.callId)])];
        if (writtenValue !== undefined && matches.some((w) => writtenValue === String(w.citation.value)))
          i.delivered.add('value');
      }
      if (refs.length || literalProof) i.delivered.add('presence');
    }
    antecedent = fieldOwner;
    accept(unit, refs, owners, matches, isRead ? 'current' : 'historical');
  }
  const hostRepair = optionalNotes.length > 0;
  for (const i of decisions) {
    if (i.state === 'confirmedEmpty') continue;
    const unique = distinctWitnesses(i.hits);
    if (
      i.fields.includes('id') &&
      !i.delivered.has('id') &&
      i.delivered.has('locator') &&
      unique.length === 1 &&
      !rejected.length &&
      repairId &&
      !text.includes('cite:')
    ) {
      const amended = text.trimEnd() + '\n\n完整 citation.id：' + unique[0].citation.id;
      const outcome = evaluateSourceDraft({
        text: amended,
        question,
        plan,
        observations,
        currentVersions,
        meaning,
        lint,
        review,
        repairId: false,
      });
      return {...outcome, hostRepair: true};
    }
    if (
      i.hits.length &&
      i.delivered.has('presence') &&
      (!i.needsLocator || i.delivered.has('locator')) &&
      i.fields.every((f) => i.delivered.has(f))
    )
      i.state = 'answered';
  }
  if (
    currentDecision &&
    currentDecision.state !== 'notApplicable' &&
    currentDecision.fields.every((f) => currentDecision.delivered.has(f))
  )
    currentDecision.state = 'answered';
  const items = [
    ...decisions,
    ...(currentDecision ? [currentDecision] : optionalRead.attemptIds.length ? [optionalRead] : []),
    ...(reviewed ? [reviewed] : []),
  ].map(({hits, related, empty, delivered, ...i}) => {
    if (i.state === 'unresolved') {
      const label = [
        i.turn ? '第' + i.turn + '轮' : '',
        i.query,
        i.book,
        i.action === 'review' ? '研究审校与直接取证' : i.action === 'read' ? '同一材料当前状态' : '历史出处',
      ]
        .filter(Boolean)
        .join(' ');
      i.reason = '未核实或未完整交付：' + label;
      gaps.push(i.reason);
    }
    return {...i, fieldsDelivered: [...delivered], ...(empty ? {emptyCallId: empty} : {})};
  });
  if (rejected.length) gaps.push('有可见陈述缺少相符的来源或超出本轮证据。');
  if (!gaps.length && !rejected.length && body.trim() === text.trim()) {
    const shift = text.indexOf(body);
    for (const r of [...claims, ...occurrences]) {
      r.start += shift;
      r.end += shift;
    }
    body = text;
  }
  if (
    !claims.some(
      (c) =>
        c.callIds.length &&
        !['execution', 'ledgerCount'].includes(c.relation) &&
        (c.relation !== 'searchResult' || decisions.some((i) => i.operation === 'exists')),
    )
  ) {
    body = '';
    claims.length = 0;
    occurrences.length = 0;
    citations.clear();
  }
  const status = body ? (gaps.length ? 'partial' : 'completed') : 'failed';
  return {
    status,
    text: body,
    citations: [...citations.values()],
    ...(gaps.length ? {reason: gaps.join('；')} : {}),
    hostRepair,
    sourceDelivery: {schema: 1, planRev: plan.rev, textDigest: digest(body), items, claims, occurrences},
    rejected,
    rejectedChecks,
    optionalNotes,
  };
}
