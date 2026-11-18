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
export function verifiedPortion(blocks, available, findingsFor, coverage) {
  const verified = [];
  for (const { header, parts } of blocks) {
    const kept = parts.filter(part => {
      if (coverage.unsupported.has(part) || (coverage.missing.length && !coverage.supported.has(part))) return false;
      const sourced = coverage.verifiedEndings.has(part) ||
        (/[。！？.!?]$/.test(part) && adoptedCitations(part, available).length);
      return sourced && !findingsFor(part).some(blockingFinding);
    });
    if (kept.length) verified.push([...(header ? [header] : []), ...kept].join('\n'));
  }
  const body = verified.join('\n\n');
  return body && !findingsFor(body).some(blockingFinding) ? body : '';
}
