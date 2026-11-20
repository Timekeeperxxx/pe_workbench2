import { asLegacyFact, lintFactIdentity } from '../../lib/fact-memory/context.mjs';
/** Shared user-turn lifecycle. Automated watch/tracking prompts never use this wrapper. */
import { argumentRequirements, buildTurnContext, checkTurnTools, PLAIN_ANSWER_GUIDANCE } from '../../lib/turn-context.mjs';
import { pendingMerges, readLedger, readLedgerSync } from '../../lib/ledger.mjs';
import { recordUserClaims } from '../../lib/claim-detect.mjs';
import { randomUUID } from 'node:crypto';
import { lintAnswer, lintLedgerAnswer, answerStats, asksDeviationQuestion, contextModelTarget } from '../../lib/answer-lint.mjs';
import { collectCitationsFromToolCalls, currentCitation, rehydrateCitations, toolEvidenceState } from '../../lib/citations.mjs';
import { validCitations } from '../../lib/contracts/citation.mjs';
import { markStaleVersions, registerToolResult } from '../../lib/fact-register.mjs';
import { frameworkForTurn, referencedJudgments, textOfContent } from './snapshot.mjs';
import { locateChatTopics, recentTopicDialogue } from './topic-locator.mjs';
import { updateTopicsFromFacts } from '../../lib/topic-index.mjs';

import { activateQueuedTurn, startTurn, saveTurnDelivery } from './turn-delivery.mjs';
import { sourceSearchGap } from './transcript-search-recovery.mjs';
import { adoptedCitations, asksHistoricalSource, answerBlocks, answerGaps, blockingFinding, hasOcrPageSource, reportedLocatorEvidence, joinContinuation, missingSummaryItems, requestedSummaryItems, reviewBodyWithinBudget, verifiedPortion, workbookItemCoverage } from './answer-delivery.mjs';
import { presentUserAnswer } from '../../ui/chat/user-facing-answer.js';
import { CONTEXT_BUDGET_FAILURE, isContextBudgetError } from '../../lib/context-budget.mjs';
import { calculateUserScenario, scenarioInterpretationFindings } from '../../lib/scenario-calculation.mjs';
import { answerCharCount, answerLengthHint, missingCompactItems, questionWithoutAttachments, requestedAnswerLength, requestedCompactItems } from '../../lib/answer-length.mjs';
import { readCitedPdfReports } from './pdf-period-evidence.mjs';
import { appendDisclosure, prepareDisclosureAnswer, preparePdfDisclosure } from './pdf-disclosures.mjs';
import { scenarioDirectionFindings } from '../../lib/financial-evidence.mjs';
import { composeResearchAnswer, distinctEditableText, requestsEvidenceLimits } from '../../lib/answer-composition.mjs';

export function runWithPostAnswer(entry, text, options = {}, broadcast = () => {}) {
  const { runId, attachments, ...promptOptions } = options;
  const prompt = attachments?.length
    ? `${text}\n\n[已上传资料]\n${attachments.map(path => `- ${path}`).join('\n')}`
    : text;
  if (entry.automated) return entry.session.prompt(prompt, promptOptions);
  const previous = entry.postAnswerRun;
  const turn = { turnId: randomUUID(), question: text, startedAt: new Date().toISOString() };
  if (runId) turn.runId = runId;
  if (previous) turn.queued = true;
  startTurn(entry, turn);
  entry.postAnswerPending = true;
  const execute = async () => {
    if (turn.queued) activateQueuedTurn(entry, turn.turnId);
    entry.managedChat = true;
    const active = entry.activeTurn = { ...turn, attachments, cancelled: false };
    broadcast({ type: 'turn.started', turnId: turn.turnId, question: text, startedAt: turn.startedAt });
    let outcome;
    try {
      outcome = await generateAnswer(entry, prompt, promptOptions, active);
    } catch (error) {
      outcome = { status: 'failed', text: '', citations: [], reason: failureReason(error) };
    }
    if (active.cancelled) outcome = { ...outcome, status: 'cancelled', reason: '用户已取消本次回答。' };
    else if (active.calculation) {
      const { body, receipt } = active.calculation;
      outcome = {
        ...outcome,
        status: outcome.status === 'failed' ? 'partial' : outcome.status,
        text: composeResearchAnswer(outcome.text, {calculatedAnswer:body}),
        calculation: receipt,
      };
    }
    if (!active.cancelled && active.pdfDisclosure) outcome = appendDisclosure(outcome, active.pdfDisclosure);
    try {
      const framework = outcome.status === 'completed' || outcome.status === 'partial'
        ? frameworkForTurn(entry.session, entry.ctx, turn.turnId, active.frameworkEdits)
        : null;
      const presentation = framework ? {
        ...framework,
        turnStartedAt: turn.startedAt,
        analysisStatePendingMerge: pendingMerges(readLedgerSync(entry.ctx.root, entry.id))
          .some(item => item.path === framework.analysisStatePath),
      } : {};
      if (!framework && active.frameworkEdits?.size) presentation.analysisState = null;
      const record = saveTurnDelivery(entry, { version: 1, turnId: turn.turnId, ...(turn.runId ? { runId: turn.runId } : {}), finishedAt: new Date().toISOString(), ...outcome, ...presentation });
      try {
        broadcast({ type: 'turn.delivered', record });
        entry.onTurnDelivered?.(record);
      } catch (error) {
        console.warn('[chat] Turn delivery notification failed:', error.message);
      }
      return record;
    } finally {
      entry.activeTurn = null;
    }
  };
  const run = previous ? previous.catch(() => {}).then(execute) : execute();
  entry.postAnswerRun = run;
  return run.finally(() => {
    if (entry.postAnswerRun === run) {
      entry.postAnswerPending = false;
      entry.postAnswerRun = null;
      // Snapshot joins (e.g. an unavailable tool-card table) cannot change
      // the already persisted decision returned to the other transport.
      try {
        if (entry.snapshot) broadcast(entry.snapshot());
      } catch (error) {
        console.warn('[chat] Could not refresh the session snapshot:', error.message);
      }
    }
  });
}

function failureReason(error) {
  const reason = String(error?.message || error || '没有生成可交付的回答。');
  return isContextBudgetError(reason) ? CONTEXT_BUDGET_FAILURE : reason;
}

async function generateAnswer(entry, promptText, options, active) {
  const { turnId, question: text } = active;
  entry.ctx?.factMemory?.recover();
  let correctionCount = 0;
  let continuationCount = 0;
  let lengthRewritten = false;
  let summaryRewritten = false;
  let safeText = '';
  let safeCitations = [];
  let beforeSoftCompaction;
  const recordLint = data => {
    entry.session.sessionManager?.appendCustomEntry('pe_answer_lint', data);
    entry.answerLint = data;
  };
  const interrupted = reason => {
    if (beforeSoftCompaction && !active.cancelled) {
      // A stylistic rewrite cannot take away a result that already passed review.
      const { data, chars, record } = beforeSoftCompaction;
      recordLint({ ...data, compaction: { draftChars: chars, deliveredChars: chars, reason: failureReason(reason) } });
      return record;
    }
    return {
      status: active.cancelled ? 'cancelled' : safeText ? 'partial' : 'failed',
      text: safeText, citations: safeCitations, reason: failureReason(reason),
    };
  };
  let latestMessage;
  let continuationPrefix = null;
  const toolCalls = entry.turnToolCalls = [];
  const registrationJobs = [];
  const turnBoundary = entry.session.messages.length;
  let candidateCallStart = 0;
  let candidateMessageStart = turnBoundary;
  entry.transcriptBoundary = turnBoundary;
  // Explicit user corrections become append-only claims before the model responds.
  const priorQuestions = entry.session.messages.filter(m => m.role === 'user' && !m.peInternal && !m.customType)
    .map(message => questionWithoutAttachments(textOfContent(message.content)));
  const turn = priorQuestions.length + 1;
  const length = requestedAnswerLength(text);
  const limit = length?.strict ? length.chars : null;
  const rewriteThreshold = length && !length.strict ? Math.floor(length.chars * 1.2) : null;
  let calculation = calculateUserScenario(text, priorQuestions);
  if (calculation && limit !== null && answerCharCount(calculation.body) >= limit) calculation = null;
  if (calculation) {
    const questions = [...priorQuestions, text];
    const sourceTurns = [...new Set(Object.values(calculation.receipt.inputs).map(input => input.userTurn))];
    calculation.receipt.sourceQuestions = sourceTurns.map(userTurn => ({ userTurn, text: questions[userTurn - 1] }));
  }
  active.calculation = calculation;
  const priorAnswers = referencedJudgments(entry.session, text, turnId);
  active.priorAnswers = priorAnswers;
  const argumentHint = argumentRequirements(text, priorAnswers);
  const priorAnswerHint = priorAnswers.length ? '指定轮次的正式答复，仅用来定位先前判断。text 为空代表没有可引用的正文，truncated 为真时可用 transcript_search 补查。\n' + JSON.stringify(priorAnswers) : '';
  const priorDialogue = recentTopicDialogue(entry.session.messages.slice(0, turnBoundary));
  const requestedItems = requestedSummaryItems(text);
  const pdfDisclosure = !calculation ? await preparePdfDisclosure(entry.ctx, active.attachments, text, priorDialogue, requestedItems, limit, priorQuestions) : null;
  active.pdfDisclosure = pdfDisclosure;
  const disclosureHeadings = pdfDisclosure?.headings || (pdfDisclosure ? [pdfDisclosure.heading] : []);
  const observedYear = pdfDisclosure?.observedYear;
  const disclosureHint = pdfDisclosure ? [
    `系统会把下面已按原文核验的“${disclosureHeadings.join('、')}”放进最终正文，页码和金额无需再次转述。`,
    pdfDisclosure.body,
    '你的答文仅写原题剩下的问项。使用简短的分项标题。说明支持哪些判断和仍缺的证据，省去对已核验数字的重复计算和背景复述。',
    pdfDisclosure.kind === 'segment_margins' ?
      (disclosureHeadings.includes('反证') ? '反证段使用同一年、同一指标的两种口径。正文其他小节省去这组增速。' :
        '单列“反证”，用前文已有的反方事实或明确的证据缺口，注明未来触发条件的假设性质。') :
      '毛利率同时受价格、成本和产品结构影响。框架中需要未来追踪的观察项写在对应小节。原题要求框架时，写清如何比较，不额外承诺核实终端价或未要求的统计数据。',
    observedYear ? `${observedYear}年集团毛利率同比改善已由年报确认。把置信度和修订结论中的“待观察”“下调”明确限定在以后能否延续。下次用新数据检验延续性。将后续同口径数据和未量化的投入归因作为待核事项。` : '',
    pdfDisclosure.scenarioCashFlow ? '现金流段已单列年报披露的历史季度与题设的未来未知项。待核清单可以说明将比较哪些指标，省去对这笔历史金额的转述和无期间的“当前值”。' : '',
  ].join('\n') : '';
  const reserved = calculation?.body || pdfDisclosure?.body || '';
  const reservedChars = answerCharCount(reserved);
  const answerBudget = limit === null ? null : limit - reservedChars;
  const lengthHint = answerLengthHint(length, reservedChars);
  active.answerLengthHint = lengthHint;
  const reviewLabel = '> **待复核**';
  const reviewBudget = answerBudget === null ? Infinity : answerBudget - answerCharCount(reviewLabel);
  const reportPeriodHint = active.attachments?.some(path => /\.pdf$/i.test(path))
    ? '引用财报金额时，在数字旁写明期间和 PDF 页码。多份年报要标明公司或文件名。需要换单位时，从原文金额用计算工具换算。分红要区分预案和已实施。先覆盖用户点名的结论，正文只保留必需的数字。'
    : '';
  const gapsHint = '若原题要求指出还缺哪些资料，把它们写在对应理由里或列为“还缺的资料”。“未核验：”只用于用户本轮要求查实而仍没能查实的事项。';
  const summaryItems = requestedItems.filter(item => !disclosureHeadings.includes(item));
  const compactBudget = length?.strict ? reviewBudget : (length?.chars ?? 0) - reservedChars;
  const compactItems = !calculation && !pdfDisclosure && !summaryItems.length && compactBudget > 0
    ? requestedCompactItems(text) : null;
  const itemBudget = compactItems ? Math.floor(compactBudget / compactItems.count) : 0;
  const compactContentHint = compactItems?.kind === '问题'
    ? '每项先写一个问句。若原题要求说明不同回答的影响，紧接着写两种回答各怎样改变判断。只需要拟问题时，删去原稿的历史数字、出处回顾和重复的“年报未披露”。'
    : compactItems?.kind === '命题'
      ? '命题用短句写判断、看什么指标、什么情况会推翻它。使用代理指标时写出它看不到什么。若原题只问如何验证，用指标名称和变化方向表达，删去原稿的历史数值、换算过程和无关指标。'
      : '';
  const compactItemHint = itemBudget > 0 ? [
    compactItems.topics
      ? `用下面的词作为行首小标题，一个主题一行，格式“主题：判断、理由”。保留全部主题：${compactItems.topics.join('、')}。`
      : `用“1. 内容”的格式逐行写齐 ${compactItems.count} 项，连续编号。每行回答一个原题要求的事项及其理由。`,
    length.strict
      ? `每项最多约 ${itemBudget} 字，含序号、标点和出处，目标约 ${Math.max(1, Math.floor(itemBudget * 0.9))} 字。先写齐所有项。`
      : `每项以 ${itemBudget} 字左右为目标。为避免漏答，可按每项的实际需要分配篇幅，保留理由和必要依据。`,
    compactContentHint,
    '省去原题未要求的开场、总括和重复背景。原题要求的数字、条件、指标局限和关键出处写在对应项内。若原题还要求单列其他内容，从各项预算腾出位置，仍须答齐。',
  ].filter(Boolean).join('\n') : '';
  const summaryHint = [
    summaryItems.length ? `按原题分别保留这些小项，每项用短标题和至少一句实质内容：${summaryItems.join('、')}。在压缩时先缩短每项，再删附加背景。` : '',
    summaryItems.includes('三项待核') ? '“三项待核”下保留三个不同的具体事项，用1、2、3编号，各写一小句。未来要查的资料填在这三项内。前文阈值若为自设假设，写明性质，省去非必需的数值。' : '',
    observedYear && answerBudget !== null ? `补充正文目标 ${Math.max(1, Math.floor(answerBudget * 0.70))} 字。除三项待核各用一句短语，其余小节各用一句，修订的不同命题可在一句内列清。用文字写方向，省略重复的财报数字、假设阈值和情景百分比。` : '',
  ].filter(Boolean).join('\n');
  const directionHint = /^(?:虚构|假设)(?:压力)?情景[：:]/u.test(text) &&
    /哪些.*(?:命题|还不能|仍不能)/su.test(text) && !/计算|量化|列公式/.test(text)
    ? '这道题问判断方向。逐条对照已有命题说明下调或维持的理由，再给出目前不能判断的事项和所缺条件。省去不影响结论的历史数字。复述题设百分比时，照原题写明指标、方向，并标为情景条件。'
    : '';
  const calculationHint = calculation ? [
    '系统会在正文首部展示以下按题设计算的结果和公式。题设数据只用于本轮假设情景。',
    calculation.body,
    '题设及所引用的前序用户题设已用于复算。原题未要求核对工作簿单元格、现实数据或其他参数时，省去这些额外核对说明。',
    `你的回复只负责补充定性解释。${calculation.supplement} 不重复上面的数字、公式和小节，不增加未要求的测算、情景、阈值或引用。`,
  ].join('\n') : '';
  try { await recordUserClaims(entry.ctx?.root, entry.id, text, { turn }); } catch { /* never block the turn */ }
  const ledgerBefore=await readLedger(entry.ctx?.root,entry.id);
  const correctionIds=(ledgerBefore?.facts||[]).filter(f=>f.source==='user_correction'&&f.turn===turn&&f.status==='current').map(f=>f.id);
  if(correctionIds.length) await updateTopicsFromFacts(entry.ctx?.root,entry.id,{factIds:correctionIds}).catch(()=>[]);
  const locator = input => locateChatTopics(entry.indexModel, input, entry.modelPayload);
  const context = await buildTurnContext({ question: text, history:priorDialogue, root: entry.ctx?.root, sessionId: entry.id, factMemory:entry.ctx?.factMemory, locator:ledgerBefore?.topics?.length?locator:undefined });
  // DT-8: opt-in delivery checklist only. Empty/absent keeps old behavior.
  const requiredSections = Array.isArray(options.requiredSections)
    ? options.requiredSections
    : Array.isArray(entry.requiredSections) ? entry.requiredSections :
      pdfDisclosure?.kind === 'dividends' ? ['品牌定价','渠道','现金转化'].filter(label => text.includes(label) && !disclosureHeadings.includes(label)) : null;
  const injectedLintContext = { ...(entry.answerLintContext || {}), ...(options.answerLintContext || {}) };
  const asksDeviation = injectedLintContext.userAsksDeviation ?? asksDeviationQuestion(text);
  const baseLintContext = {
    ...injectedLintContext,
    ...(asksDeviation ? { userAsksDeviation: true } : {}),
    ...(requiredSections?.length ? { requiredSections } : {}),
  };
  const unsubscribe = entry.session.subscribe?.(event => {
    if (event.type === 'message_end' && event.message?.role === 'assistant') latestMessage = event.message;
    if (event.type === 'tool_execution_start') toolCalls.push({ id: event.toolCallId, name: event.toolName, args: event.args, messageIndex: entry.session.messages.length, success: false });
    if (event.type === 'tool_execution_end') {
      const call = toolCalls.findLast(c => c.id === event.toolCallId);
      if (call) {
        call.details = event.result?.details; call.result=event.result;
        call.success = event.isError === false && toolEvidenceState(event.result) !== 'failed';
        if(call.success) registrationJobs.push(registerToolResult(entry.ctx?.root,entry.id,call,{turn}).catch(()=>[]));
      }
    }
    if (event.type === 'agent_settled' && event.aborted) active.cancelled = true;
  });
  try {
    const priorCitations = Array.isArray(entry.citationIndex) ? entry.citationIndex : [];
    let boundary = entry.session.messages.length;
    if (active.cancelled) return interrupted('用户已取消本次回答。');
    // Older fake sessions may omit custom messages: context injection is skipped there.
    if (entry.session.sendCustomMessage) {
      const content = [context.content, argumentHint, priorAnswerHint, lengthHint, calculationHint, disclosureHint, reportPeriodHint, gapsHint, directionHint, summaryHint].filter(Boolean).join('\n\n');
      await entry.session.sendCustomMessage({ customType: 'pe_turn_context', content, display: false, details: { turnId, routes: context.routes } }, { deliverAs: 'nextTurn' });
    }
    if (active.cancelled) return interrupted('用户已取消本次回答。');
    await entry.session.prompt(promptText, options);
    for (;;) {
      const message = latestMessage || entry.session.messages.slice(boundary).findLast(item => item.role === 'assistant');
      if (message?.stopReason === 'aborted') active.cancelled = true;
      if (active.cancelled) return interrupted('用户已取消本次回答。');
      if (!['length', 'stop'].includes(message?.stopReason)) {
        const failedTool = toolCalls.findLast(call => !call.success);
        return interrupted(message?.errorMessage || (failedTool && `工具 ${failedTool.name} 执行失败。`));
      }
      const delta = textOfContent(message.content);
      const prefix = continuationPrefix ?? '';
      const joined = message.researchContinuation ? delta : joinContinuation(prefix, delta);
      const noProgress = continuationPrefix !== null && joined.trimEnd() === prefix.trimEnd();
      const reviewedCalculation = calculation?.completeAnswer && message.researchVerifiedCalculation && joined.trim() === calculation.body;
      const modelText = reviewedCalculation ? '' : distinctEditableText(presentUserAnswer(joined), reserved);
      const reviewedLimits = requestsEvidenceLimits(text) ? new Set(message.researchAnsweredLimits || []) : new Set();
      const classified = !reviewedLimits.size ? modelText : modelText.replace(/(^|[。！？\n])([ \t]*(?:[-*][ \t]+)?)未核验[：:][ \t]*([^。！？\n]+)/gu,
        (line, start, indent, content) => reviewedLimits.has(content.trim()) ? start + indent + '判断还缺的资料：' + content : line);
      const {text:answer, removed:disclosureAdjustments} = prepareDisclosureAnswer(classified, pdfDisclosure, requestedItems, text);
      const visible = composeResearchAnswer(answer,{calculatedAnswer:calculation?.body, verifiedPdfDisclosure:pdfDisclosure});
      // Also support restored/minimal sessions that expose tool messages but no events.
      const scanned = [];
      const messages = entry.session.messages.slice(turnBoundary);
      for (const [index, m] of messages.entries()) for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type !== 'toolCall') continue;
        const result = messages.find(r => r.role === 'toolResult' && r.toolCallId === c.id);
        scanned.push({ messageIndex: turnBoundary + index, id:c.id, name: c.name, args: c.arguments, argumentsError: c.argumentsError, success: Boolean(result) && result.isError === false && toolEvidenceState(result) !== 'failed', details:result?.details, result });
      }
      for(const call of scanned) if(call.success) registrationJobs.push(registerToolResult(entry.ctx?.root,entry.id,call,{turn}).catch(()=>[]));
      const registered= (await Promise.all(registrationJobs)).flat().filter(Boolean);
      // Deduplicate restored and live copies by execution ID. The live terminal
      // event is authoritative, including a failure with a valid-looking payload.
      const calls = [...new Map([...scanned, ...toolCalls].map(call => [call.id, call])).values()];
      const thisTurnCitations = collectCitationsFromToolCalls(calls.toReversed());
      const historical = calls.filter(call => call.success && call.name === 'transcript_search')
        .flatMap(call => call.details?.matches || [])
        .filter(match => match?.role === 'assistant' && Number.isInteger(match.turn))
        .map(match => ({ turn: match.turn, citations: validCitations(match.citations).filter(cite => cite.version) }));
      const currentVersions = { ...entry.materialVersions };
      let refreshedLedger = await readLedger(entry.ctx?.root, entry.id);
      if(entry.ctx?.factMemory) {const project=entry.ctx.factMemory.query({limit:100}); refreshedLedger={...(refreshedLedger || {}),corrections:[],facts:project.facts.map(asLegacyFact)};}
      const materialIds = new Set([...thisTurnCitations, ...(refreshedLedger?.facts || []).map(f => f.citation)]
        .map(c => c?.materialId).filter(Boolean));
      for (const call of calls) {
        const id = (call.result?.details || call.details)?.materialId;
        if (call.name === 'pdf_read' && id) materialIds.add(id);
      }
      for (const id of materialIds) {
        const latest = entry.ctx?.store?.getLatestMaterialVersion?.(id)?.v;
        if (latest != null) currentVersions[id] = latest;
      }
      // Minimal sessions may have no material catalogue. Use the newest
      // observed version in that case, independent of tool completion order.
      const observedVersions = new Map();
      for (const {materialId, version} of thisTurnCitations) if (version) {
        observedVersions.set(materialId, Math.max(version, observedVersions.get(materialId) || 0));
      }
      for (const [id, version] of observedVersions) currentVersions[id] ??= version;
      await markStaleVersions(entry.ctx?.root,entry.id,currentVersions).catch(()=>0);
      if (registered.length) {
        await updateTopicsFromFacts(entry.ctx?.root, entry.id, { factIds: registered.map(fact => fact.id) })
          .catch(error => console.warn('[chat] Could not update session topics:', error.message));
      }
      const turnCitations = rehydrateCitations({register:refreshedLedger,answer,thisTurnCitations,currentVersions,toolCalls:calls});
      entry.citationIndex = turnCitations;
      const pdfReports = await readCitedPdfReports(entry.ctx, active.attachments, calls, answer);
      const lintContext = { ...baseLintContext, question:text, citations: turnCitations, toolCalls: calls, currentVersions, pdfReports, pdfDisclosure, calculation, ...(priorCitations.length ? { priorCitations } : {}) };
      const workbookReads = calls.filter(call => call.name === 'workbook_query' || call.name === 'workbook_trace');
      const workbookEvidence = collectCitationsFromToolCalls(workbookReads).filter(c => currentCitation(c, currentVersions));
      const blocks = answerBlocks(answer);
      const workbookTurn = active.attachments?.some(path => /\.xls[xm]$/i.test(path)) || workbookReads.length > 0;
      const coverage = workbookItemCoverage(text, blocks, workbookEvidence, workbookTurn);
      const locatorEvidence = candidate => reportedLocatorEvidence(candidate, text, turnCitations, historical, workbookEvidence);
      const sourceReport = locatorEvidence(answer);
      const available = sourceReport.citations;
      const findingsFor = (candidate, checkContext = lintContext) => {
        const lastLine = candidate.slice(candidate.lastIndexOf('\n') + 1);
        const report = candidate === answer ? sourceReport : locatorEvidence(candidate);
        const verifiedEnding = coverage.verifiedEndings.has(lastLine) || report.endsWithIdField || report.endsWithNoGaps;
        const structuralText = reviewedCalculation && candidate === answer ? visible : candidate;
        const lint = lintAnswer(structuralText, { ...checkContext, locatorCitations: report.citations }).filter(finding =>
          finding.rule !== 'incomplete' || finding.message !== '句末可能截断' || !verifiedEnding);
        if (report.conflict) lint.push({
          rule: 'unverified_locator', severity: 'error', message: '出处所述材料、版本或引用缺少对应证据',
          excerpt: report.conflict, expected: '历史出处须与命中的正式答文一致，当前版本须由本轮读取同一材料核实',
        });
        const findings = [
          ...lintFactIdentity(candidate, entry.ctx?.factMemory, { question: text, calculation }),
          ...lint,
          ...lintLedgerAnswer(candidate, refreshedLedger, {
            ...checkContext, locatorCitations: report.citations, locatorFindings: lint.filter(f => f.rule === 'unverified_locator'), toolCalls: calls,
          }),
          ...checkTurnTools({ answer: candidate, routes: context.routes, toolCalls: calls }),
          ...scenarioInterpretationFindings(candidate, calculation?.receipt),
        ];
        const chars = answerCharCount(candidate) + reservedChars;
        if (limit !== null && chars > limit) findings.push({
          rule: 'answer_length', severity: 'error', message: `正文超出原题字数上限 ${limit} 字`,
          excerpt: `合计 ${chars} 字`, expected: `压缩至 ${limit} 字以内`,
        });
        if (rewriteThreshold !== null && chars > rewriteThreshold) findings.push({
          rule: 'answer_length_target', severity: 'warning', message: `正文偏离 ${length.chars} 字的篇幅目标`,
          excerpt: `合计 ${chars} 字`, expected: '先保留各问项、理由和必要出处，再酌情缩短',
        });
        return findings;
      };
      const findings = findingsFor(answer);
      for (const issue of message.researchAnswerGaps || []) {
        findings.push({ rule: 'delivery_gap', severity: 'error', message: issue.reason, excerpt: issue.excerpt });
      }
      const directions = directionHint ? scenarioDirectionFindings(answer, text) : [];
      findings.push(...directions);
      const missingItems = missingSummaryItems(visible, requestedItems);
      const compactMissing = lengthRewritten && compactItemHint ? missingCompactItems(answer, compactItems) : [];
      const unanswered = [...missingItems, ...compactMissing];
      if (unanswered.length) findings.push({
        rule:'missing_requested_section', severity:'error', excerpt:unanswered.join('、'),
        message:`缺少原题要求的内容：${unanswered.join('、')}`, expected:'补上对应内容并保留原题其他问项',
      });
      const adopted = adoptedCitations(answer, available);
      const adoptedIds = new Set([...adopted.map(citation => citation.id), ...coverage.evidenceIds]);
      const candidateCalls = [...scanned.filter(call => call.messageIndex >= candidateMessageStart), ...toolCalls.slice(candidateCallStart)];
      const lastVerifiedRead = candidateCalls.findLastIndex(call => call.name === 'workbook_query' && call.success &&
        collectCitationsFromToolCalls([call]).some(citation => adoptedIds.has(citation.id)));
      for (const gap of new Set([...answerGaps(answer), ...coverage.missing])) {
        if (gap === '无' && sourceReport.endsWithNoGaps) continue;
        findings.push({ rule: 'delivery_gap', severity: 'error', message: `未核验：${gap}`, excerpt: gap });
      }
      if (message.stopReason === 'length' && !findings.some(f => f.rule === 'incomplete')) {
        findings.push({ rule: 'incomplete', severity: 'error', message: '模型达到输出长度上限', expected: '从断点补完回答' });
      }
      if (noProgress) findings.push({ rule: 'incomplete', severity: 'error', message: '续写没有补充缺失内容。' });
      const data = {
        version: 1, turnId, timestamp: new Date().toISOString(),
        findings, stats: answerStats(answer), correctionCount, continuationCount,
        citations: available,
        ...(disclosureAdjustments.length ? {disclosureAdjustments} : {}),
        messageIndex: entry.session.messages.lastIndexOf(message),
      };
      // Custom entries are durable metadata, never model-visible chat messages.
      recordLint(data);
      // A requested item already classified as a delivery gap follows the
      // established partial-delivery path. Other identity errors get one retry.
      const errors = findings.filter(item => item.severity === 'error' && !['incomplete', 'delivery_gap', 'answer_length', 'missing_requested_section'].includes(item.rule) &&
        !(item.rule === 'evidence_identity_mismatch' && [...coverage.unsupported].some(part => part.includes(item.excerpt))));
      const incomplete = findings.some(item => item.rule === 'incomplete');
      const tooLong = findings.some(item => item.rule === 'answer_length');
      const isPdfConflict = finding => ['pdf_period_mismatch', 'pdf_amount_mismatch', 'pdf_source_mismatch'].includes(finding.rule);
      const pdfConflicts = findings.filter(isPdfConflict);
      const pdfCorrections = [...new Set(pdfConflicts.map(item => `${item.excerpt}；按原文应为 ${item.expected}`))];
      const unverified = findings.filter(item => item.rule === 'unverified_locator' || item.rule === 'orphaned_number');
      const blocking = findings.filter(blockingFinding);
      // A retry may change the sheet or path. Only count a successful read
      // toward recovery if the final answer actually cites its evidence.
      const latestTools = new Map();
      for (const call of candidateCalls) latestTools.set(call.name + JSON.stringify(call.args || {}), call);
      const sourceQuestion = asksHistoricalSource(text);
      const searchGap = sourceQuestion && sourceSearchGap(text, answer, scanned, toolCalls, sourceReport.historical, blocks, coverage,
        clause => Boolean(locatorEvidence(clause).historical?.length) && !findingsFor(clause).some(blockingFinding));
      const failedTool = [...latestTools.values()].find(call => !call.success &&
        !(sourceQuestion && call.name === 'transcript_search') &&
        (call.name !== 'workbook_query' || candidateCalls.lastIndexOf(call) >= lastVerifiedRead));
      const toolGap = [searchGap, failedTool && `工具 ${failedTool.name} 执行失败。`].filter(Boolean).join('；');
      if (reviewedCalculation && !blocking.length && !toolGap) return {status:'completed',text:'',citations:[]};
      const deliverable = answer && !blocking.length && !toolGap;
      const draftChars = answerCharCount(answer) + reservedChars;
      if (beforeSoftCompaction && (!deliverable || draftChars >= beforeSoftCompaction.chars)) {
        return interrupted(blocking[0]?.message || toolGap || (answer ? '改稿没有缩短正文。' : '改稿没有生成正文。'));
      }
      // Only attempt an optional rewrite when the requested sections can be
      // checked again, and retain the already approved version if it loses any.
      const softCompaction = deliverable && !sourceQuestion && !lengthRewritten && (compactItemHint || summaryItems.length) &&
        findings.some(item => item.rule === 'answer_length_target');
      if (observedYear && lengthRewritten && tooLong && blocking.length === 1 && !toolGap && !sourceQuestion) {
        // Length alone may be repaired locally. Keep the list and every
        // revised conclusion, then apply the normal checks to the shorter text.
        const compact = reviewBodyWithinBudget(answer, blocks, answerBudget, undefined, summaryItems, ['已修订的结论']);
        if (compact && !answerGaps(compact).length && !missingSummaryItems(compact, summaryItems).length) {
          const checked = findingsFor(compact);
          if (!checked.some(blockingFinding)) {
            const citations = locatorEvidence(compact).citations;
            const compacted = {...data, findings:checked, stats:answerStats(compact), citations,
              compaction:{draftChars:answerCharCount(answer) + reservedChars, deliveredChars:answerCharCount(compact) + reservedChars}};
            recordLint(compacted);
            return {status:'completed', text:compact, citations:adoptedCitations(compact, citations)};
          }
        }
      }
      if (calculation?.optionalSupplement && !sourceQuestion && !toolGap && !coverage.missing.length &&
          blocking.length && blocking.every(finding => ['delivery_gap', 'answer_length'].includes(finding.rule))) {
        // The calculation already answers the full request. Drop an optional
        // supplement with unrelated unknowns or excess length, never its evidence.
        return { status: 'completed', text: '', citations: [] };
      }
      if (blocking.length || !answer || toolGap) {
        safeText = verifiedPortion(answer, blocks, locatorEvidence,
          part => findingsFor(part, { ...lintContext, requiredSections: [] }), coverage,
          part => hasOcrPageSource(part, calls, currentVersions));
        safeCitations = adoptedCitations(safeText, locatorEvidence(safeText).citations);
      } else if (!softCompaction) {
        return { status: 'completed', text: answer, citations: adopted };
      } else {
        beforeSoftCompaction = { data, chars: draftChars, record: { status: 'completed', text: answer, citations: adopted } };
      }
      const facingAnswer = [
        '界面把最后一次工具调用之后的文字当作回答，此前的文字放进过程。用户还没有看到这份草稿。这段回答直接回答用户原问题，像第一次作答。不要写核验过程，不要逐项交代检查，不要评价上一稿对错，也不要宣布这是改过的一版。出处写在句子里，工作簿坐标采用 [文件名]Sheet!A1。',
        PLAIN_ANSWER_GUIDANCE,
        argumentHint, priorAnswerHint, lengthHint, calculationHint, disclosureHint, reportPeriodHint, gapsHint, directionHint, summaryHint,
      ].filter(Boolean).join('\n');
      let prompt;
      let customType = 'pe_answer_correct';
      const targetErrors = errors.filter(item => item.code === 'G1' || item.code === 'G2');
      if (message.stopReason === 'length' && continuationCount < 1) {
        customType = 'pe_answer_continue';
      } else if (targetErrors.length && correctionCount < 1) {
        correctionCount++;
        continuationPrefix = null;
        const knownTarget = contextModelTarget(lintContext);
        const targetHint = knownTarget !== null ? `本会话/状态已有模型目标价 ${knownTarget}；` : '';
        prompt = `目标价/偏离答文不合格：${targetErrors.map(item => `${item.message}：${item.excerpt}`).join('；')}。\n${targetHint}请用本轮工具或会话状态中的模型目标价（valuations 的 V*.output=target_price、workbook_trace 估值输出格或明确 target_price locator）与 westock_query 现价重写首句，格式“模型目标价 <值> vs 现价 <值>，空间 ≈ <X>%”；G1/G2 只是缺口 ID，禁止写成单元格，禁止用“没有独立目标价单元格/先纠正前提/无法精确回答”挡掉；券商目标价只作对照。${facingAnswer}`;
      } else if (pdfConflicts.length && correctionCount < 1 && !incomplete) {
        correctionCount++;
        continuationPrefix = null;
        prompt = [
          '财报原文已指出这些金额的正确期间、数值或出处。请按证据纠正，并重算受影响的合计和比率。省去原题不需要的财报金额。',
          ...pdfCorrections,
          facingAnswer,
        ].join('\n');
      } else if (unverified.length && correctionCount < 1) {
        correctionCount++;
        continuationPrefix = null;
        prompt = `以下单元格引用缺少唯一可核验的出处：\n${unverified.map(item => item.excerpt).join('\n')}\n同名坐标必须补上文件名，文件同名时使用 [材料ID@v版本]Sheet!A1。没有依据的坐标应删除或注明“未核验”。若数字也没有其他出处，同时删除/替换该数字，或标明未核验。\n${facingAnswer}`;
      } else if (directionHint && correctionCount < 1 && !incomplete) {
        correctionCount++;
        continuationPrefix = null;
        prompt = [
          '按已有命题和题设给一份短的定性判断。原题各项输入都要回应，说明相反变化能否抵消及缺哪个条件。用方向和条件表达，省去未要求的年报数字、重复的比例和阈值数字。',
          lengthHint, gapsHint,
          ...directions.map(item => `${item.message}。${item.expected}。`),
          JSON.stringify({question: text, previous:priorDialogue, draft:answer}),
        ].filter(Boolean).join('\n');
        active.compactAnswer = prompt;
      } else if ((errors.length || (calculation && requestsEvidenceLimits(text) && blocking.some(item => item.rule === 'delivery_gap'))) && correctionCount < 1) {
        correctionCount++;
        continuationPrefix = null;
        const issues = [...new Set(errors.map(item => [item.message, item.excerpt, item.expected].filter(Boolean).join('；')))];
        prompt = `以下主张需要核对。先保留足以回答各问项的结论和有证据的关键数字。多余数字直接删去，题目要求的事实未能核对时再注明。\n${issues.join('\n')}\n${facingAnswer}`;
        if (calculation && !sourceQuestion && !toolGap && !unverified.length) {
          prompt = [
            '你在一份已有计算段的答复下续写解释，读者已看到下面的计算。根据原题重新写这一小段，逐项说清为什么。',
            '如果本题的数值已经在计算段列齐，解释段用指标名称和变化方向指代它们。省去重复报数、重算、背景和额外测算。虚构情景没有要求核实的现实数据不需另列为未核验。',
            PLAIN_ANSWER_GUIDANCE, calculation.supplement, gapsHint, lengthHint,
            JSON.stringify({原题:text, 前面用户已读到的段落:calculation.body,
              需注意:[...new Set(blocking.map(item => item.message))]}),
          ].filter(Boolean).join('\n');
          active.compactAnswer = {prompt,verifyAnswer:true};
        }
      } else if (!incomplete && ((tooLong && !lengthRewritten) || softCompaction || (missingItems.length && !summaryRewritten))) {
        if (tooLong || softCompaction) lengthRewritten = true;
        if (missingItems.length) summaryRewritten = true;
        continuationPrefix = null;
        const unsupported = [...new Set(errors.filter(item => item.rule === 'unsourced_number').map(item => item.excerpt))];
        prompt = [
          tooLong ? `原稿合计 ${draftChars} 字，超过原题字数上限 ${limit} 字。请将需要你写的部分压到 ${compactItemHint ? reviewBudget : answerBudget} 字以内。` : lengthHint,
          softCompaction ? `原稿合计 ${draftChars} 字。可整理得更短，完整保留原题各问项、关键理由及必要出处。` : '',
          missingItems.length ? `原稿还缺少 ${missingItems.join('、')}。补上这些问项，保留已写齐的其余问项。` : '',
          compactItemHint, argumentHint, priorAnswerHint,
          '按原题逐项写短段，每段保留一个判断和一句具体理由。保留这些判断所需的证据、成立或推翻的条件，以及原题要求的最后一项。',
          '给每个问项先留够一两句的字数。每项只用最能支持判断的事实，证据局限写进该项。先删开场、重复结论、与问题无关的待核说明和多余数字，逐项核对还有答案和理由。',
          reportPeriodHint, calculationHint, disclosureHint, gapsHint, directionHint, summaryHint,
          pdfCorrections.length ? '下列原文核对结果必须落实，受影响的合计或比率须用更正后的金额计算。' : '',
          ...pdfCorrections,
          JSON.stringify({question: text, draft: answer, unsupported}),
        ].filter(Boolean).join('\n');
        active.compactAnswer = softCompaction ? { prompt, approvedDraft: answer } : prompt;
      } else if (incomplete && continuationCount < 1) {
        customType = 'pe_answer_continue';
      } else {
        const gaps = [...new Set(blocking.map(item => item.rule === 'answer_length'
          ? `改稿合计仍超出原题上限 ${limit} 字` : item.message))].join('；');
        const reason = [gaps, toolGap].filter(Boolean).join('；') || '没有生成可交付的回答。';
        // A finished draft can be read for review even if no sentence can be
        // delivered as verified. Direct requests for source evidence still need it.
        const needsExplanation = calculation && !calculation.optionalSupplement;
        if ((needsExplanation || (!calculation && !safeText)) && answer && blocking.length && !incomplete && !sourceQuestion && !coverage.missing.length) {
          const wrongDirection = directions.some(item => item.field === 'direction');
          let omit;
          if (needsExplanation) {
            // A bad cell reference does not disqualify an independent explanation
            // of what is missing from the scenario. Keep it labeled for review.
            omit = part => coverage.unsupported.has(part) ||
              findingsFor(part, { ...lintContext, requiredSections: [] }).some(blockingFinding) ||
              (message.researchAnswerGaps || []).some(issue => issue.excerpt && part.includes(issue.excerpt));
          } else if (pdfConflicts.length || wrongDirection) {
            omit = part => findingsFor(part).some(isPdfConflict) ||
              (wrongDirection && scenarioDirectionFindings(part, text).some(item => item.field === 'direction'));
          }
          const reviewText = reviewBodyWithinBudget(answer, blocks, reviewBudget, omit, summaryItems);
          if (reviewText) {
            const droppedItems = lengthRewritten && compactItemHint
              ? missingCompactItems(reviewText, compactItems).filter(item => !compactMissing.includes(item)) : [];
            const dropped = droppedItems.length ? `按字数交付后缺少：${droppedItems.join('、')}` : '';
            const citations = needsExplanation ? adoptedCitations(reviewText, locatorEvidence(reviewText).citations) : [];
            return { status: 'partial', text: `${reviewLabel}\n\n${reviewText}`, citations, reason: [reason, dropped].filter(Boolean).join('；') };
          }
        }
        return interrupted(reason);
      }
      if (customType === 'pe_answer_continue') {
        continuationCount++;
        continuationPrefix = joined;
        prompt = ['上一条回答在句中截断，请从断点继续补完，不要重复已写内容。补齐该判断的理由及余下问项。', lengthHint, calculationHint].filter(Boolean).join('\n');
      }
      if (active.cancelled) return interrupted('用户已取消本次回答。');
      active.continueResearchAnswer = continuationPrefix === null ? null : delta => joinContinuation(continuationPrefix, delta);
      latestMessage = null;
      boundary = entry.session.messages.length;
      if (customType === 'pe_answer_correct') {
        candidateCallStart = toolCalls.length;
        candidateMessageStart = boundary;
      }
      if (entry.session.sendCustomMessage) {
        // SDK resolves after the triggered run settles (agent_settled), as prompt does.
        await entry.session.sendCustomMessage({ customType, content: prompt, display: false, details: { turnId, correctionCount, continuationCount } }, { triggerTurn: true });
      } else {
        // Fake/test-only compatibility. Production Pi supports sendCustomMessage.
        // Fakes that append user messages must retain peInternal (snapshot hides it).
        await entry.session.prompt(prompt, { peInternal: true });
      }
      active.compactAnswer = null;
    }
  } catch (error) {
    return interrupted(error);
  } finally {
    await Promise.allSettled(registrationJobs);
    unsubscribe?.();
  }
}
