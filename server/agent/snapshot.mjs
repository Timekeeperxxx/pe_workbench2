/**
 * Conversation snapshot: Pi session messages -> the compact DTO the browser
 * renders. Tool presentations are joined from the host's durable table, never
 * parsed out of Markdown or model text.
 */

import path from "node:path";
import {turnTimeline} from "./turn-delivery.mjs";
import {readLedgerSync, pendingMerges} from "../../lib/ledger.mjs";

export function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

export function shortPath(ctx, value) {
  if (typeof value !== "string") return "";
  const rel = path.relative(ctx.root, path.resolve(ctx.root, value));
  if (rel && !rel.startsWith("..")) return rel.split(path.sep).join("/");
  return value;
}

export function toolDetail(ctx, name, args = {}) {
  switch (name) {
    case "read":
    case "write":
    case "edit":
    case "ls":
      return shortPath(ctx, args.path || ".");
    case "grep":
      return args.pattern || "";
    case "find":
      return args.pattern || "";
    case "bash":
      return args.command || "";
    case "workbook_query":
      return `${shortPath(ctx, args.path || "")} · ${args.query || ""}`.trim();
    case "workbook_trace":
      return [
        shortPath(ctx, args.path || ""),
        args.cell || (args.sheet ? `${args.sheet}${args.rows ? ` 行 ${args.rows}` : ""}` : ""),
      ].filter(Boolean).join(" · ").slice(0, 160);
    case "validate_state":
      return shortPath(ctx, args.path || "");
    case "asr_read":
      return shortPath(ctx, args.path || "");
    case "westock_query":
      return Array.isArray(args.args) ? args.args.join(" ").slice(0, 120) : "";
    case "anysearch_search":
      return String(args.query || "").slice(0, 120);
    case "web_fetch":
      return String(args.url || "").slice(0, 200);
    default:
      return JSON.stringify(args || {}).slice(0, 80);
  }
}

export function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) return textOfContent(result.content);
  try {
    return JSON.stringify(result).slice(0, 2000);
  } catch {
    return "";
  }
}

export function hm(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function makeTitle(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "新会话";
  const first = clean.split(/[，。！？；,.!?;\n]/)[0].trim() || clean;
  return first.length > 28 ? `${first.slice(0, 28)}…` : first;
}

// Pi may compact its model context. History walks the active session branch
// (including custom lifecycle entries) instead of indexing session.messages.
function conversationTurns(session) {
  const timeline = turnTimeline(session);
  const turns = [];
  const managed = new Map();
  let current;
  for (const item of timeline) {
    if (item.kind === "start") {
      if (managed.has(item.turn.turnId)) continue;
      const turn = { start: item.turn, messages: [] };
      turns.push(turn);
      managed.set(item.turn.turnId, turn);
      if (!item.turn.queued) current = turn;
    } else if (item.kind === "active") {
      current = managed.get(item.turnId);
    } else if (item.kind === "delivery") {
      const turn = managed.get(item.record.turnId);
      if (turn && !turn.delivery) turn.delivery = item.record;
    } else if (item.kind === "lint") {
      if (current && !current.start) current.lint = item.data;
    } else if (item.kind === "message") {
      const { message } = item;
      if (message.peInternal || message.customType || message.role === "custom") continue;
      if (message.role === "user") {
        if (!current?.start || current.user || current.delivery) {
          current = { messages: [] };
          turns.push(current);
        }
        current.user = message;
      } else if (message.role === "assistant" || message.role === "toolResult") {
        if (!current) {
          current = { messages: [] };
          turns.push(current);
        }
        current.messages.push(message);
      }
    }
  }
  return turns;
}

function userMessage(turn) {
  if (!turn.user && !turn.start) return null;
  const text = String(turn.start?.question ?? textOfContent(turn.user?.content))
    .replace(/\n\n\[已上传资料\][\s\S]*$/, "");
  return {
    role: "user", text, timestamp: turn.start?.startedAt ?? turn.user?.timestamp,
    ...(turn.start ? { turnId: turn.start.turnId } : {}),
  };
}

export function titleFromMessages(session) {
  const first = conversationTurns(session).find(turn => turn.start || turn.user);
  return makeTitle(first && userMessage(first).text);
}

export function lastAssistantText(session) {
  const messages = session?.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = textOfContent(message.content).trim();
    if (text) return text;
  }
  return "";
}

// Older sessions put text before the last tool in the process view and
// join subsequent text as the answer, including historical continuations.
function legacyAnswer(turn) {
  const process = [];
  const final = [];
  for (const message of turn.messages) {
    if (message.role !== "assistant") continue;
    const text = textOfContent(message.content).trim();
    if (text) final.push(text);
    if (Array.isArray(message.content) && message.content.some(block => block.type === "toolCall")) {
      process.push(...final.splice(0));
    }
  }
  if (!final.length && process.length) {
    const parts = process.join("\n\n").split("\n\n");
    return { text: parts.pop(), processText: parts.join("\n\n").trim() };
  }
  return { text: final.join("\n\n"), processText: process.join("\n\n") };
}

function answerMessage(turn) {
  const { start, delivery } = turn;
  if (!start) return legacyAnswer(turn);
  return {
    turnId: start.turnId,
    text: delivery?.text ?? "",
    citations: delivery?.citations ?? [],
    status: delivery?.status ?? "pending",
    ...(delivery?.reason ? { reason: delivery.reason } : {}),
    ...(delivery ? { finishedAt: delivery.finishedAt } : {}),
  };
}

export function snapshotMessages(session, ctx, entry = null) {
  const turns = conversationTurns(session);
  const presentations = new Map();
  const citationsByCall = new Map();
  if (entry) {
    for (const record of ctx.store.listToolPresentations({ threadId: entry.id })) {
      presentations.set(record.toolCallId, record);
    }
    for (const record of ctx.store.listToolCitations?.({ threadId: entry.id }) || []) {
      if (Array.isArray(record.citations) && record.citations.length) {
        citationsByCall.set(record.toolCallId, record.citations);
      }
    }
  }
  const stateContents = new Map(); // reconstructed successful writes/edits, never current disk state
  const out = [];
  for (const turn of turns) {
    const user = userMessage(turn);
    if (user) {
      const {timestamp, ...message} = user;
      out.push({ ...message, time: hm(timestamp) });
    }
    const current = { tools: [] };
    const results = new Map(turn.messages.filter(m => m.role === "toolResult").map(m => [m.toolCallId, m]));
    const calls = turn.messages.flatMap(m => m.role === "assistant" && Array.isArray(m.content)
      ? m.content.filter(block => block.type === "toolCall") : []);
    for (const block of calls) {
      const result = results.get(block.id);
      const record = presentations.get(block.id);
      const presentation = record && !record.corrupt && record.payload
        && record.schemaName !== "presentation.error"
        ? {
            schema: { name: record.schemaName, version: record.schemaVersion },
            payload: record.payload,
          }
        : null;
      const presentationError = record?.corrupt
        ? "工具结果展示数据损坏"
        : record?.schemaName === "presentation.error"
          ? String(record.payload?.error || "工具结果展示数据不可用")
          : "";
      const args = block.arguments || {};
      const statePath = shortPath(ctx, args.path || "");
      if (result && !result.isError && /(?:^|\/)analysis-state\.json$/.test(statePath)) {
        if (block.name === "read") {
          // Successful full reads provide an immutable baseline in a new session.
          // Partial/truncated reads must not be mistaken for a complete state.
          const readContent = resultText(result);
          try {
            const parsed = JSON.parse(readContent);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stateContents.set(statePath, readContent);
          } catch { /* no usable baseline */ }
        }
        let content = stateContents.get(statePath);
        if (block.name === "write" && typeof args.content === "string") content = args.content;
        else if (block.name === "edit") {
          if (typeof content === "string") {
            const patches = Array.isArray(args.edits)
              ? args.edits
              : (typeof args.oldText === "string"
                ? [{ oldText: args.oldText, newText: args.newText ?? "" }]
                : null);
            if (patches?.length) {
              let next = content;
              let ok = true;
              for (const patch of patches) {
                if (!patch || typeof patch.oldText !== "string" || next.split(patch.oldText).length !== 2) {
                  ok = false;
                  break;
                }
                next = next.replace(patch.oldText, () => patch.newText ?? "");
              }
              content = ok ? next : undefined;
            } else content = undefined;
          } else content = undefined;
        }
        if (["write", "edit"].includes(block.name)) {
          stateContents.delete(statePath);
          delete current.analysisState;
          if (typeof content === "string") {
            stateContents.set(statePath, content);
            try {
              const parsed = JSON.parse(content);
              if (parsed?.presentation) { current.analysisState = parsed; current.analysisStatePath = statePath; }
            } catch { /* malformed writes fall back to the assistant's text */ }
          }
        }
      }
      const citations = citationsByCall.get(block.id) ?? result?.details?.citations ?? [];
      current.tools.push({
        id: block.id,
        name: block.name,
        detail: toolDetail(ctx, block.name, block.arguments || {}),
        status: result ? (result.isError ? "error" : "done") : !turn.start ? "done" : turn.delivery ? "error" : "running",
        output: result ? resultText(result).slice(0, 4000) : "",
        ...(citations.length ? { citations } : {}),
        ...(presentation ? { presentation } : {}),
        ...(presentationError ? { presentationError } : {}),
      });
    }
    const answer = answerMessage(turn);
    if (turn.start || answer.text || answer.processText || current.tools.length || current.analysisState) {
      const firstAssistant = turn.messages.find(m => m.role === "assistant");
      const legacyCitations = new Map();
      if (!turn.start) {
        for (const cite of [...(turn.lint?.citations || []), ...current.tools.flatMap(tool => tool.citations || [])]) {
          if (!legacyCitations.has(cite.id)) legacyCitations.set(cite.id, cite);
        }
      }
      out.push({
        role: "assistant", ...current, ...answer,
        ...(legacyCitations.size ? { citations: [...legacyCitations.values()] } : {}),
        time: hm(turn.delivery?.finishedAt ?? firstAssistant?.timestamp ?? user?.timestamp),
        turnStartedAt: user?.timestamp ?? firstAssistant?.timestamp,
      });
    }
  }
  return out;
}

export function serializeSession(entry) {
  return {
    type: "snapshot",
    pendingMerges: entry.automated ? [] : pendingMerges(readLedgerSync(entry.ctx.root, entry.id)),
    sessionId: entry.id,
    title: entry.title,
    messages: snapshotMessages(entry.session, entry.ctx, entry),
    streaming: Boolean(entry.session.isStreaming || entry.postAnswerPending),
    activeTurnId: entry.activeTurn?.turnId ?? null,
    model: entry.modelId,
    projectId: entry.ctx.id,
    approvals: entry.ctx.store.listApprovalRequests({ threadId: entry.id, limit: 50 }),
  };
}
