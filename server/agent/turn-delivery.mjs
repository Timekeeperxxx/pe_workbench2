import { existsSync, linkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// User-turn metadata lives on the active Pi JSONL branch, outside model context.
// Minimal in-memory sessions use the same markers at raw message boundaries.
const memoryMarkers = new WeakMap();
const START = "pe_turn_started";
const DELIVERY = "pe_turn_delivery";
const ACTIVE = "pe_turn_active";

export function appendTurnMarker(session, type, data) {
  const manager = session.sessionManager;
  const file = manager?.getSessionFile?.();
  try {
    manager?.appendCustomEntry(type, data);
  } catch (error) {
    // Pi mutates its in-memory branch before writing. Drop any phantom entry
    // before a retry or a snapshot can mistake it for a durable decision.
    if (file && existsSync(file)) manager.setSessionFile(file);
    throw error;
  }
  if (!manager?.getBranch) {
    const markers = memoryMarkers.get(session) || [];
    markers.push({ index: session.messages.length, type: "custom", customType: type, data });
    memoryMarkers.set(session, markers);
  }
}

const appendMarker = appendTurnMarker;

export function turnTimeline(session) {
  let entries = session.sessionManager?.getBranch?.();
  if (!Array.isArray(entries)) {
    entries = [];
    const markers = memoryMarkers.get(session) || [];
    const messages = session.messages || [];
    let marker = 0;
    for (let i = 0; i <= messages.length; i++) {
      while (markers[marker]?.index === i) entries.push(markers[marker++]);
      if (i < messages.length) entries.push({ type: "message", message: messages[i] });
    }
  }
  const timeline = [];
  for (const item of entries) {
    if (item.type === "custom_message") {
      timeline.push({ kind: "message", message: { role: "custom", customType: item.customType } });
    }
    if (item.type === "message") timeline.push({ kind: "message", entryId:item.id, message: item.message });
    if (item.type !== "custom") continue;
    if (item.customType === START) timeline.push({ kind: "start", turn: item.data });
    if (item.customType === 'pe_source_plan') timeline.push({kind:'plan',plan:item.data});
    if (item.customType === ACTIVE) timeline.push({ kind: "active", turnId: item.data.turnId });
    if (item.customType === DELIVERY) timeline.push({ kind: "delivery", record: item.data });
    if (item.customType === "pe_source_cancel") timeline.push({kind:"cancel-intent",turnId:item.data.turnId});
    if (item.customType === "pe_answer_lint") timeline.push({ kind: "lint", data: item.data });
  }
  return timeline;
}

export function startTurn(entry, turn) {
  const manager = entry.session.sessionManager;
  const file = manager?.getSessionFile?.();
  if (file && !existsSync(file)) {
    // Pi normally defers its initial file until the first model-visible
    // message. The accepted user turn must be recoverable during preparation
    // too. Install a valid branch atomically, then use normal Pi appends.
    const temp = file + '.' + randomUUID() + '.tmp';
    const jsonl = [manager.getHeader(), ...manager.getEntries()].map(item => JSON.stringify(item)).join('\n') + '\n';
    writeFileSync(temp, jsonl, { flag: 'wx', mode: 0o600 });
    try {
      linkSync(temp, file);
      manager.setSessionFile(file);
    } finally {
      unlinkSync(temp);
    }
  }
  appendTurnMarker(entry.session, START, turn);
}

export function activateQueuedTurn(entry, turnId) {
  appendTurnMarker(entry.session, ACTIVE, { turnId });
}

// First terminal decision wins. The read/append pair is synchronous, under the
// session service's single owner for this thread. Return the stored version.
export function saveTurnDelivery(entry, record) {
  const timeline = turnTimeline(entry.session);
  const existing = timeline.find(item => item.kind === "delivery" && item.record.turnId === record.turnId);
  if (existing) return existing.record;
  const start=timeline.find(item=>item.kind==='start' && item.turn.turnId===record.turnId)?.turn;
  if (start?.sourceSchema===1) record=finalizeSourceTurn(timeline,record);
  try {
    appendMarker(entry.session, DELIVERY, record);
  } catch (error) {
    if (!entry.session.sessionManager?.getSessionFile?.()) throw error;
    const saved = turnTimeline(entry.session).find(item => item.kind === "delivery" && item.record.turnId === record.turnId);
    if (saved) return saved.record;
    appendMarker(entry.session, DELIVERY, record);
  }
  return record;
}

// Adjudicate every managed outcome inside the existing synchronous single writer.
function finalizeSourceTurn(timeline,record) {
  const cancelled=timeline.some(i=>i.kind==='cancel-intent' && i.turnId===record.turnId);
  if (cancelled) return {...record,status:'cancelled',reason:'用户已取消本次回答。'};
  const plan=timeline.findLast(i=>i.kind==='plan' && i.plan.turnId===record.turnId)?.plan;
  if (record.status==='failed' || record.status==='cancelled' || plan?.route==='ordinary') return record;
  if (!plan || record.sourceDelivery?.schema!==1 || record.sourceDelivery.planRev!==plan.rev) {
    return {...record,status:'failed',text:'',citations:[],sourceDelivery:undefined,reason:'请求计划或对应的已核实正文缺失。'};
  }
  return record;
}

export function recoverInterruptedTurns(entry) {
  const timeline = turnTimeline(entry.session);
  const cancelled = new Set(timeline.filter(item=>item.kind==="cancel-intent").map(item=>item.turnId));
  const delivered = new Set(timeline.filter(item => item.kind === "delivery").map(item => item.record.turnId));
  for (const item of timeline) {
    if (item.kind === "start" && !delivered.has(item.turn.turnId)) {
      saveTurnDelivery(entry, {
        version: 1, turnId: item.turn.turnId, ...(item.turn.runId ? { runId: item.turn.runId } : {}), status: cancelled.has(item.turn.turnId)?"cancelled":"failed", text: "", citations: [],
        reason: cancelled.has(item.turn.turnId)?"用户已取消本次回答。":"服务在回答交付前中断。", finishedAt: new Date().toISOString(),
      });
    }
  }
}

export async function cancelActiveTurn(entry) {
  const active=entry.activeTurn;
  if (active && !active.cancelled) {
    if (active.sourceSchema && !turnTimeline(entry.session).some(r=>r.kind==='delivery' && r.record.turnId===active.turnId))
      appendTurnMarker(entry.session,'pe_source_cancel',{turnId:active.turnId});
    active.cancelled=true;
    active.controller?.abort();
  }
  await entry.session.abort();
}
