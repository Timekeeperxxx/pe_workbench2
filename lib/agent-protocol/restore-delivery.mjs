import { EventType, TERMINAL_EVENT_TYPES } from "./ag-ui-events.mjs";
import { RunStateMachine } from "./run-state-machine.mjs";

// Rebuild only the missing suffix. Existing rows (and Last-Event-ID cursors)
// survive a crash between the session commit and any AG-UI tail frame.
export function restoreDeliveryTail(log, threadId, record) {
  const { runId, turnId } = record;
  const scope = { threadId, runId };
  if (log.hasTerminal(scope)) return;
  const saved = new Set();
  const machine = new RunStateMachine({ ...scope, emit(event) {
    if (!saved.has(event.type)) log.append({ ...scope, eventType: event.type, event });
  } });
  let afterSequence = 0;
  for (;;) {
    const rows = log.list({ ...scope, afterSequence, limit: 256 });
    if (!rows.length) break;
    for (const row of rows) {
      if (row.threadId !== threadId || row.runId !== runId) throw new Error("mismatched AG-UI recovery scope");
      const event = row.payload;
      if (TERMINAL_EVENT_TYPES.has(event.type)) return;
      if (event.type === EventType.RUN_STARTED || event.messageId === turnId ||
          (event.type === EventType.CUSTOM && event.name === "pe.turn_delivery" && event.value?.turnId === turnId)) {
        saved.add(event.type);
      }
      if (event.type === EventType.TOOL_CALL_START) {
        machine.openToolCalls.set(event.toolCallId, { name: event.toolCallName, endEmitted: false, resultEmitted: false });
      } else if (event.type === EventType.TOOL_CALL_END) {
        const tool = machine.openToolCalls.get(event.toolCallId);
        if (tool) tool.endEmitted = true;
      } else if (event.type === EventType.TOOL_CALL_RESULT) {
        machine.openToolCalls.delete(event.toolCallId);
      }
    }
    afterSequence = rows.at(-1).sequence;
  }
  // The managed protocol always emits exactly one full content frame.
  // Existing parts are skipped by emit() while the state machine balances
  // every opened tool (including a persisted END with its RESULT missing).
  machine.start();
  machine.publishDelivery(record);
  if (record.status === "failed") machine.fail({ message: record.reason || "回答生成失败", code: "turn_failed" });
  else machine.finish({ aborted: record.status === "cancelled" });
}
