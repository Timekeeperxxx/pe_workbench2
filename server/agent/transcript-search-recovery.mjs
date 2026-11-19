import { parseStreamingJson } from '@earendil-works/pi-ai';
import { explicitTurns } from './answer-delivery.mjs';
import { citationFilenames, locatorKey, maskCitationIds } from '../../lib/citation-locator.mjs';

const SEARCH = /查询|检索|搜索|查找|查(?:一下)?|\bsearch\b/i;
const KEYWORD = /^(?:关键词|关键字|字词|短语)?\s*[:：]?\s*/;

function queryKey(query) {
  return typeof query === 'string' ? query.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

// Bind literal operands to the search that introduces them. Quoted output
// fields later in a request (e.g. 报告“完整 ID”) are not additional queries.
function requestedSearches(question) {
  const targets = [];
  const rounds = explicitTurns(question);
  for (const clause of question.split(/[。！？；;，,\n]/)) {
    const verb = SEARCH.exec(clause);
    if (!verb) continue;
    const operand = clause.slice(verb.index + verb[0].length).trim().replace(KEYWORD, '');
    const terms = [...operand.matchAll(/[“「『"']([^”」』"'\n]+)[”」』"']/g)];
    if (!terms.length && operand && !/轮|报告|回答|答文|出处|引用/.test(operand)) {
      terms.push({ 1: operand, index: 0, 0: operand });
    }
    let turns = explicitTurns(clause.slice(0, verb.index));
    let end = 0;
    for (const term of terms) {
      const prefix = operand.slice(end, term.index);
      if (/报告|回答|输出|显示|列出|返回/.test(prefix)) break;
      const local = explicitTurns(prefix);
      if (local.size) turns = local;
      const scoped = turns.size ? turns : rounds.size === 1 ? rounds : [];
      targets.push({ query: queryKey(term[1]), turns: [...scoped] });
      end = term.index + term[0].length;
    }
  }
  return targets;
}

function turnRange(args = {}) {
  if (args.turn != null) return [args.turn, args.turn];
  return args.turnRange;
}

function coversTurn(args, turn) {
  const range = turnRange(args);
  return Array.isArray(range) && range[0] <= turn && turn <= range[1];
}

// Pi keeps malformed JSON in the diagnostic, with empty final arguments.
// Read its partial selectors only to rule out a different target.
function retryOf(call, success, targets, rounds) {
  const raw = call.argumentsError?.split('\n\nReceived arguments:\n')[1];
  const failed = { ...(raw && parseStreamingJson(raw)), ...call.args };
  const args = success.args ?? {};
  if (Object.keys(failed).some(key => !['query', 'turn', 'turnRange', 'limit'].includes(key))) return false;
  const query = queryKey(args.query);
  if (!query) return false;
  if (failed.query) {
    if (queryKey(failed.query) !== query) return false;
  } else {
    const requested = targets.length ? targets.some(target => target.query === query) :
      rounds.size === 1 && coversTurn(args, [...rounds][0]);
    if (!requested) return false;
  }

  const scope = turnRange(failed);
  if (scope) {
    const retry = turnRange(args);
    if (!Array.isArray(scope) || scope.length !== 2 || !retry || scope[0] !== retry[0] || scope[1] !== retry[1]) return false;
    if (failed.turn != null && failed.turnRange && !coversTurn({ turnRange: failed.turnRange }, failed.turn)) return false;
  } else if (turnRange(args)) {
    // A narrower retry of an unscoped call is sufficient only for the
    // round(s) actually requested for this keyword.
    const selected = targets.filter(t => t.query === query).flatMap(t => t.turns);
    if (!(selected.length ? selected : [...rounds]).some(turn => coversTurn(args, turn))) return false;
  }
  return true;
}

// Restrict a hit only for a single, explicitly named workbook. Read its
// entire name from the request so a suffix cannot select another workbook.
function requestedWorkbook(question) {
  if ((question.match(/\.xls[xm]\b/gi) || []).length !== 1) return;
  return /(?:只|仅)(?:需|要)?(?:报告|列出|说明|给出)[^。；;]*?(?:工作簿|文件)\s*[「“\[]?([^「」“”\[\]，。；;]+?\.xls[xm])(?=[」”\]\s，。；;的]|$)/i.exec(question)?.[1].trim();
}

function coveredTurns(call, sources, literalIds, workbook) {
  const turns = new Set();
  if (!call.success || call.details?.coverage?.truncated) return turns;
  for (const hit of call.details?.matches || []) {
    if (hit.role !== 'assistant' || !hit.citations?.length) continue;
    const required = workbook ? hit.citations.filter(cell => citationFilenames(cell).includes(workbook)) : hit.citations;
    if (required.length && required.every(cell => sources.some(({ citation, turns }) => turns.has(hit.turn) &&
      citation.id === cell.id && citation.materialId === cell.materialId && citation.version === cell.version &&
      locatorKey(citation.locator) === locatorKey(cell.locator) && (!literalIds || literalIds.has(cell.id))))) {
      turns.add(hit.turn);
    }
  }
  return turns;
}

// Coalesce event/JSONL copies, then account for all requested search targets
// across the turn. Rewriting a draft does not resolve an earlier failed task.
export function unresolvedSourceSearch(question, answer, scanned, events, sources = []) {
  const calls = new Map();
  for (const call of [...scanned, ...events]) {
    if (call.name !== 'transcript_search') continue;
    const prior = calls.get(call.id);
    calls.set(call.id, { ...prior, ...call, messageIndex: prior?.messageIndex ?? call.messageIndex });
  }
  const ordered = [...calls.values()].sort((a, b) => a.messageIndex - b.messageIndex);
  const firstFailure = ordered.find(call => !call.success);
  if (!firstFailure) return;
  let ids;
  if (/引用\s*ID|完整\s*ID|citation[ ._-]*id/i.test(question)) {
    ids = new Set();
    maskCitationIds(answer, sources.map(source => source.citation), cell => { if (cell) ids.add(cell.id); });
  }
  const workbook = requestedWorkbook(question);
  const verified = ordered.map(call => coveredTurns(call, sources, ids, workbook));
  const targets = requestedSearches(question);
  const rounds = explicitTurns(question);
  for (const { query, turns } of targets) {
    const covered = new Set(ordered.flatMap((call, i) =>
      queryKey(call.args?.query) === query ? [...verified[i]].filter(turn => !turns.length || coversTurn(call.args, turn)) : []));
    if (!covered.size || !turns.every(turn => covered.has(turn))) return firstFailure;
  }
  return ordered.find((call, i) => !call.success && !ordered.some((success, j) =>
    j > i && verified[j].size && retryOf(call, success, targets, rounds)));
}
