import assert from "node:assert/strict";
import { MemoryAgentEventLog } from "../lib/agent-protocol/event-log.mjs";
import { PiAgUiAdapter } from "../lib/agent-protocol/pi-ag-ui-adapter.mjs";
import { RunStateMachine } from "../lib/agent-protocol/run-state-machine.mjs";

const threadId = "thread";
const runId = "run";
const turnId = "turn";
const workspaceId = "fixture";
const scope = { threadId, runId };
const makeLog = () => new MemoryAgentEventLog({ workspaceId });
const makeAdapter = (log, options) => new PiAgUiAdapter({ session: { subscribe: () => () => {} }, threadId, workspaceId, log, ...options });

function append(log, event) {
  return log.append({ ...scope, eventType: event.type, event });
}
function withoutTimestamp({ timestamp, ...event }) { return event; }

for (const status of ["completed", "partial", "failed", "cancelled"]) {
  const text = ["completed", "partial"].includes(status) ? "这是完整句。" : "";
  const record = { ...scope, turnId, status, text, citations: [], reason: "fixture reason" };
  const full = [];
  const machine = new RunStateMachine({ ...scope, emit: event => full.push(event) });
  machine.start();
  machine.startToolCall({ toolCallId: "call", toolName: "read", args: {} });
  machine.publishDelivery(record);
  if (status === "failed") machine.fail({ message: record.reason, code: "turn_failed" });
  else machine.finish({ aborted: status === "cancelled" });

  // Crash before the first frame, during text/custom delivery, or between
  // TOOL_CALL_END and RESULT. Existing cursors must point to the same rows.
  for (let count = 0; count <= full.length; count++) {
    const log = makeLog();
    const prefix = full.slice(0, count).map(event => append(log, event));
    const adapter = makeAdapter(log);
    adapter.recoverDelivery(record);
    const repaired = log.records.slice();
    adapter.recoverDelivery(record);
    assert.deepEqual(log.records, repaired);
    assert.deepEqual(log.records.slice(0, count), prefix);
    const data = repaired.map(row => row.payload);
    const expected = count >= 3 ? full : full.filter(event => !event.type.startsWith("TOOL_CALL"));
    if (count === 2) {
      // Only the tool start survived. The adapter recovers its END/RESULT.
      expected.splice(1, 0, full[1]);
      expected.splice(-1, 0, ...full.filter(e => ["TOOL_CALL_END", "TOOL_CALL_RESULT"].includes(e.type)));
    }
    assert.deepEqual(data.map(withoutTimestamp), expected.map(withoutTimestamp), status + " at " + count);
  }
}

// Prefixes can span many tool progress pages.
{
  const log = makeLog();
  const machine = new RunStateMachine({ ...scope, emit: event => append(log, event) });
  machine.start();
  machine.startToolCall({ toolCallId: "search", toolName: "search", args: {} });
  for (let i = 0; i < 520; i++) machine.progressToolCall({ toolCallId: "search", content: String(i) });
  machine.endToolCall({ toolCallId: "search", content: "ok" });
  const last = log.records.at(-1);
  makeAdapter(log).recoverDelivery({ ...scope, turnId, status: "completed", text: "B", citations: [] });
  assert.equal(log.locate(last.eventId), last);
  assert.deepEqual(log.records.slice(last.sequence).map(row => row.eventType),
    ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "CUSTOM", "RUN_FINISHED"]);
}

// The replay DB can be temporarily unavailable while the session commits. The
// live client still sees the recorded result and the durable prefix is retained.
for (const outage of ["once", "until-reconnect"]) {
  const log = makeLog();
  const write = log.append.bind(log);
  let unavailable = true;
  log.append = args => {
    if (args.eventType !== "RUN_STARTED" && unavailable) {
      if (outage === "once") unavailable = false;
      throw new Error("simulated write outage");
    }
    return write(args);
  };
  let resolve;
  const waiting = new Promise(done => { resolve = done; });
  let record;
  const adapter = makeAdapter(log, { promptRunner: async (_text, { runId }) => {
    await waiting;
    return record = { runId, turnId, text: "B", status: "completed", citations: [] };
  } });
  const seen = [];
  adapter.subscribeEvents(row => seen.push(row));
  await adapter.runPrompt("test");
  adapter.handlePiEvent({ type: "agent_start" });
  adapter.handlePiEvent({ type: "tool_execution_start", toolCallId: "call", toolName: "read" });
  adapter.handlePiEvent({ type: "agent_settled" });
  assert.equal(adapter.isRunning, true);
  const completion = adapter.activeRun.completion;
  resolve();
  await completion;
  assert.equal(seen.at(-1).eventType, "RUN_FINISHED");
  assert.deepEqual(seen.filter(e => e.payload.name === "pe.turn_delivery").map(e => e.payload.value), [record]);
  const start = log.records[0];
  unavailable = false;
  adapter.recoverDelivery(record);
  assert.equal(log.records[0], start);
  assert.equal(log.records.at(-1).eventType, "RUN_FINISHED");
  assert.deepEqual(log.records.filter(e => e.payload.name === "pe.turn_delivery").map(e => e.payload.value), [record]);
}
console.log("AG-UI delivery recovery passed (all crash positions, pagination and temporary replay-log failures)");
