import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import vm from "node:vm";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { loadConfig } from "../server/config.mjs";
import { createWorkbench } from "../server/create-app.mjs";

// Run the actual HTTP handlers, including SSE encoding, without binding a port.
async function request(app, path, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]);
  req.method = body === undefined ? "GET" : "POST";
  req.headers = headers;
  const res = new EventEmitter();
  let buffer = "";
  res.writeHead = (status) => { res.status = status; };
  res.write = (chunk) => { buffer += chunk; return true; };
  res.end = (chunk) => { if (chunk) res.write(chunk); res.writableEnded = true; };
  await app.handleApi(req, res, new URL(path, "http://local.test"));
  assert.ok(res.status >= 200 && res.status < 300, `${req.method} ${path}: ${res.status} ${buffer}`);
  return {
    json: () => JSON.parse(buffer),
    disconnect() { req.emit("close"); res.emit("close"); },
  };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

function scriptModel(entry, steps) {
  let count = 0;
  entry.session.agent.streamFunction = async (model, _ctx, opts) => {
    const step = steps[count++];
    assert.ok(step, "unexpected extra request to the model");
    const stopReason = opts.signal?.aborted ? "aborted" : step.stopReason ?? "stop";
    const content = step.tool ? [{ type: "toolCall", id: `source-${count}`,
      name: "workbook_query", arguments: step.tool }]
      : [{ type: "text", text: step.text || "" }];
    const output = stopReason === "length" ? model.maxTokens : 10;
    const message = {
      role: "assistant", content, stopReason, timestamp: Date.now(), api: model.api, provider: model.provider, model: model.id,
      usage: { input: 20, output, cacheRead: 0, cacheWrite: 0, totalTokens: 20 + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...message, content: [] } });
    if (step.text) stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: message });
    if (stopReason === "error" || stopReason === "aborted") {
      stream.push({ type: "error", reason: stopReason, error: { ...message, errorMessage: "fixture model stopped" } });
    } else {
      stream.push({ type: "done", reason: stopReason, message });
    }
    return stream;
  };
  return { count: () => count };
}

function publicAnswer(item) {
  return { turnId: item.turnId, text: item.text, citations: item.citations, status: item.status, reason: item.reason };
}

await test("Issue #10 regressions through uploads, Pi chat, delivery and refresh", async t => {
  const root = await mkdtemp(join(tmpdir(), "pe-delivery-xlsx-"));
  const oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "offline-test-credential";
  let app;
  t.after(async () => {
    try { await app?.close(); } finally {
      if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = oldKey;
      await rm(root, { recursive: true, force: true });
    }
  });
  const config = await loadConfig({ root, env: {
    ASR: "0", WATCH_SCHEDULER: "0", TRACKING_SCHEDULER: "0", MONITOR_SCHEDULER: "0", SOURCE_SCHEDULER: "0",
  } });
  app = await createWorkbench({ config: { ...config, indexModel: undefined } });
  execFileSync(process.env.PYTHON_BIN || "python3", ["-c", `
from openpyxl import Workbook
from pathlib import Path
import sys
for filename, value in [('A.xlsx', 111), ('B.xlsx', 222)]:
    book = Workbook()
    book.active.title = 'Model'
    book.active['B1'] = '2025年'
    book.active['A2'] = '收入'
    book.active['B2'] = value
    if filename == 'A.xlsx':
        book.active['C2'] = 112
        book.active['A3'] = '净利润'
        book.active['B3'] = 33
    book.save(Path(sys.argv[1]) / filename)
`, root]);
  const [a, b] = await Promise.all(["A.xlsx", "B.xlsx"].map(async name =>
    (await request(app, "/api/upload", await readFile(join(root, name)), {
      "x-file-name": name, "content-type": "application/octet-stream",
    })).json()));
  const query = (book, sheet = "Model", coord = "B2") => ({
    tool: { path: book.path, query: `${sheet}!${coord}`, sheet }, stopReason: "toolUse",
  });
  const aRef = "A.xlsx 的收入为 111（见 [A.xlsx]Model!B2）。";
  const bRef = "B.xlsx 的收入为 222（见 [B.xlsx]Model!B2）。";

  async function turn(question, steps, { attachments = [], transport = "legacy" } = {}) {
    const { id } = (await request(app, "/api/sessions", {})).json();
    const entry = app.live.get(id);
    const model = scriptModel(entry, steps);
    const url = `/api/sessions/${id}`;
    if (transport === "agui") {
      const stream = await request(app, "/api/ag-ui/agent/pi/run", { threadId: id, prompt: question, attachments });
      stream.disconnect();
    } else {
      await request(app, url + "/messages", { text: question, attachments });
    }
    const record = await bounded(entry.postAnswerRun, "turn did not settle");
    const messages = (await request(app, url + "/state")).json().messages;
    const assistant = messages.find(m => m.role === "assistant");
    assert.deepEqual(publicAnswer(assistant), publicAnswer(record), "refresh must use the persisted delivery");
    const entries = entry.session.sessionManager.getBranch();
    assert.deepEqual(entries.filter(e => e.customType === "pe_turn_delivery").map(e => e.data), [record]);
    assert.equal(model.count(), steps.length);
    assert.equal(messages.find(m => m.role === "user").text, question);
    return { record, assistant, entries, modelQuestion: entry.session.messages.find(m => m.role === "user").content };
  }

  globalThis.document = { querySelector: () => null };
  globalThis.window = {};
  const { messageHTML } = await import("../ui/chat/renderer.js");
  const bootstrap = await readFile(new URL("../ui/bootstrap.js", import.meta.url), "utf8");
  const clickHandler = bootstrap.match(/threadEl\.addEventListener\('click', (e => \{[\s\S]*?\n  \})\);/)[1];
  async function openedCells(message) {
    const body = messageHTML({ ...message, tools: [] });
    const opened = [];
    const click = vm.runInNewContext(clickHandler, {
      openFile: (materialId, version, locator) => opened.push({ materialId, version, locator }),
    });
    for (const [button] of body.matchAll(/<button[^>]+data-cell-cite[^>]+>/g)) {
      const dataset = Object.fromEntries([...button.matchAll(/data-([\w-]+)="([^"]*)"/g)]
        .map(([, key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
      click({ target: { closest: selector => selector === "[data-cell-cite]" ? { dataset } : null } });
    }
    return Promise.all(opened.map(async ({ materialId, version, locator }) => {
      const [sheet, coord] = locator.split("!");
      const base = `/api/materials/${materialId}/versions/${version}/workbook`;
      const manifest = (await request(app, base)).json();
      const grid = (await request(app, `${base}/sheets/${sheet}`)).json();
      const [, column, row] = /^([A-Z])(\d+)$/.exec(coord);
      return { materialId, version, locator, filename: manifest.fileName,
        value: grid.cells.find(([r, c]) => r === Number(row) && c === column.charCodeAt(0) - 64)?.[2] };
    }));
  }
  const destination = (book, value, coord = "B2") => ({
    materialId: book.material.id, version: 1, locator: `Model!${coord}`, filename: book.name, value,
  });
  for (const reads of [[a, b], [b, a]]) {
    for (const [asked, response, expected] of [
      ["A.xlsx", aRef, [destination(a, 111)]],
      ["B.xlsx", bRef, [destination(b, 222)]],
      ["A.xlsx 和 B.xlsx", aRef + bRef, [destination(a, 111), destination(b, 222)]],
    ]) {
      await t.test(`references for ${asked}, reading ${reads.map(book => book.name).join(" then ")}`, async () => {
        const { record, assistant } = await turn(`${asked} 的收入是多少？`, [...reads.map(book => query(book)), { text: response }]);
        assert.deepEqual(await openedCells(assistant), expected);
        assert.equal(record.status, "completed");
        assert.equal(record.text, response);
      });
    }
  }
  await t.test("an ambiguous bare reference requests correction", async () => {
    const draft = "收入为 111，见 Model!B2。";
    const { record, assistant, entries } = await turn("A.xlsx 的收入是多少？",
      [query(a), query(b), { text: draft }, { text: aRef }]);
    assert.ok(entries.some(e => e.customType === "pe_answer_correct"));
    assert.equal(record.text, aRef);
    assert.deepEqual(await openedCells(assistant), [destination(a, 111)]);
  });
  await t.test("an explicitly unverified bare reference stays unlinked after refresh", async () => {
    const response = aRef + "另一个出处 Model!B2（未核验）。";
    const { record, assistant } = await turn("说明 A.xlsx 的收入。", [query(a), query(b), { text: response }]);
    assert.equal(record.text, response);
    assert.deepEqual(await openedCells(assistant), [destination(a, 111)]);
  });

  for (const stopReason of ["length", "stop"]) {
    for (const [name, prefix, delta, expected] of [
      ["local echo", "第一项已核实。第二项取决于", "第二项取决于交付日期。", "第一项已核实。第二项取决于交付日期。"],
      ["suffix echo within a clause", "第一项已核实。第二项主要取决于交付", "取决于交付日期。", "第一项已核实。第二项主要取决于交付日期。"],
      ["no overlap", "第一项已核实。第二项取决于", "交付日期。", "第一项已核实。第二项取决于交付日期。"],
      ["whole prefix", "第一项已核实。第二项取决于", "第一项已核实。第二项取决于交付日期。", "第一项已核实。第二项取决于交付日期。"],
      ["natural repetition", "这件事还要再", "再考虑一下。", "这件事还要再再考虑一下。"],
      ["short restarted metric", "第一项已核实。毛利率", "毛利率略有下降。", "第一项已核实。毛利率略有下降。"],
      ["restarted metric before a colon", "第一项已核实。毛利率", "毛利率：维持原先水平。", "第一项已核实。毛利率：维持原先水平。"],
      ["short repetition inside a clause", "第一项已核实。这个结论很重要", "很重要，需要记录。", "第一项已核实。这个结论很重要很重要，需要记录。"],
      ["natural three-character repetition at the sentence start", "终于通过了。太好了", "太好了终于能交付了。", "终于通过了。太好了太好了终于能交付了。"],
    ]) {
      await t.test(`continuation ${stopReason}: ${name}`, async () => {
        const { record, entries } = await turn("请说明结论。", [{ text: prefix, stopReason }, { text: delta }]);
        assert.equal(record.text, expected);
        assert.equal(record.status, "completed");
        assert.ok(entries.some(e => e.customType === "pe_answer_continue"));
      });
    }
  }
  await t.test("continuation length: replay of a complete sentence", async () => {
    const { record } = await turn("请说明结论。", [
      { text: "第一项已核实。第二项也已核实。", stopReason: "length" },
      { text: "第二项也已核实。交付日期待定。" },
    ]);
    assert.equal(record.text, "第一项已核实。第二项也已核实。交付日期待定。");
    assert.equal(record.status, "completed");
  });
  for (const [name, question, suffix, status] of [
    ["single metric recovered", "收入是多少？", "", "completed"],
    ["second metric declared missing", "收入和净利润各是多少？", "\n\n未核验：净利润。", "partial"],
    ["second metric left unanswered", "收入和净利润各是多少？", "", "partial"],
  ]) {
    await t.test(`workbook retry delivery: ${name}`, async () => {
      const revenue = "收入为 111，见 Model!B2。";
      const { record, assistant } = await turn(question, [
        query(a, "WrongSheet"), query(a), { text: revenue + suffix },
      ]);
      assert.deepEqual(assistant.tools.map(tool => tool.status), ["error", "done"]);
      assert.equal(record.status, status);
      assert.equal(record.text, revenue);
      if (status === "partial") assert.match(record.reason, /净利润/);
    });
  }
  await t.test("workbook retry delivery: both requested values recovered", async () => {
    const response = "A表收入为 111，见 [A.xlsx]Model!B2。B表收入为 222，见 [B.xlsx]Model!B2。";
    const { record, assistant } = await turn("A表收入和B表收入各是多少？", [
      query(a, "WrongSheet"), query(a), query(b), { text: response },
    ]);
    assert.equal(record.status, "completed");
    assert.equal(record.text, response);
    assert.deepEqual(assistant.tools.map(tool => tool.status), ["error", "done", "done"]);
    assert.deepEqual(await openedCells(assistant), [destination(a, 111), destination(b, 222)]);
  });
  for (const question of ["收入和净利润各是多少？", "请分别给出收入和净利润", "列出收入和净利润"]) {
    for (const [transport, attachments] of [["legacy", []], ["legacy", [a.path]], ["agui", [a.path]]]) {
      await t.test(`missing profit: ${question} (${transport}, ${attachments.length ? "attached" : "unattached"})`, async () => {
        const response = "收入为 111";
        const { record, assistant, entries, modelQuestion } = await turn(question, [
          query(a, "WrongSheet"), query(a), { text: response },
        ], { transport, attachments });
        assert.equal(record.status, "partial");
        assert.match(record.reason, /净利润/);
        assert.equal(record.text, response);
        assert.deepEqual(assistant.tools.map(tool => tool.status), ["error", "done"]);
        assert.equal(entries.find(e => e.customType === "pe_turn_started").data.question, question);
        if (attachments.length) assert.ok(JSON.stringify(modelQuestion).includes(a.path));
      });
    }
  }
  await t.test("a cited income answer still has a profit gap with the workbook attached", async () => {
    const response = "收入为 111，见 Model!B2。";
    const { record, assistant } = await turn("收入和净利润各是多少？", [
      query(a, "WrongSheet"), query(a), { text: response },
    ], { attachments: [a.path] });
    assert.equal(record.status, "partial");
    assert.match(record.reason, /净利润/);
    assert.deepEqual(await openedCells(assistant), [destination(a, 111)]);
  });
  for (const phrasing of ["为", "约为"]) {
    await t.test(`an income citation cannot substantiate 净利润${phrasing} 111`, async () => {
      const revenue = "收入为 111，见 Model!B2。";
      const { record, assistant } = await turn("列出收入和净利润", [
        query(a, "WrongSheet"), query(a), { text: revenue + `净利润${phrasing} 111，见 Model!B2。` },
      ]);
      assert.equal(record.status, "partial");
      assert.match(record.reason, /净利润/);
      assert.equal(record.text, revenue);
      assert.deepEqual(await openedCells(assistant), [destination(a, 111)]);
    });
  }
  const metrics = [
    { name: "收入", value: 111, coord: "B2" },
    { name: "净利润", value: 33, coord: "B3" },
  ];
  async function checkMetricAnswer(question, layout, reads, answers) {
    const reported = metrics.slice(0, answers);
    const response = layout === "table"
      ? ["| 指标 | 数值 | 出处 |", "| --- | --- | --- |",
        ...reported.map(m => `| ${m.name} | ${m.value} | Model!${m.coord} |`)].join("\n")
      : reported.map(m => `${m.name}为${m.value}，见 Model!${m.coord}。`).join("");
    const { record, assistant } = await turn(question, [
      ...metrics.slice(0, reads).map(m => query(a, "Model", m.coord)), { text: response },
    ], { attachments: [a.path] });
    assert.equal(record.status, answers === 2 ? "completed" : "partial", JSON.stringify(record));
    if (answers === 1) assert.match(record.reason, /净利润/);
    assert.equal(record.text, response);
    assert.deepEqual(record.citations.map(c => c.locator), reported.map(m => "Model!" + m.coord));
    const targets = reported.map(m => destination(a, m.value, m.coord));
    assert.deepEqual(await openedCells({ role: "assistant", ...record }), targets);
    assert.deepEqual(await openedCells(assistant), targets);
  }
  for (const question of ["2025年收入和净利润各是多少？", "2025年收入和净利润是多少？"]) {
    for (const layout of ["paragraph", "table"]) {
      for (const count of [2, 1]) {
        await t.test(`metric coverage: ${question} (${layout}, ${count} answered)`,
          () => checkMetricAnswer(question, layout, count, count));
      }
    }
  }
  await t.test("metric coverage: polite list request", () =>
    checkMetricAnswer("请帮我列出收入和净利润", "paragraph", 1, 1));
  await t.test("metric coverage: profit read but omitted from answer", () =>
    checkMetricAnswer("2025年收入和净利润是多少？", "paragraph", 2, 1));
  await t.test("metric coverage: a table row must cite its own value even when both cells were read", async () => {
    const verified = "| 指标 | 数值 | 出处 |\n| --- | --- | --- |\n| 收入 | 111 | Model!B2 |";
    const { record, assistant } = await turn("2025年收入和净利润是多少？", [
      query(a), query(a, "Model", "B3"), { text: verified + "\n| 净利润 | 33 | Model!B2 |" },
    ], { attachments: [a.path] });
    assert.equal(record.status, "partial");
    assert.match(record.reason, /净利润/);
    assert.equal(record.text, verified);
    assert.deepEqual(record.citations.map(c => c.locator), ["Model!B2"]);
    assert.deepEqual(await openedCells(assistant), [destination(a, 111)]);
  });
  for (const [opening, closing] of [["（", "）"], [" —— ", ""]]) {
    await t.test(`an explicit gap keeps verified list items ending in ${opening}source${closing}`, async () => {
      const body = metrics.map(m => `- 2025年${m.name}：${m.value}${opening}[A.xlsx]Model!${m.coord}${closing}`).join("\n");
      const { record, assistant } = await turn("2025年收入和净利润是多少？", [
        query(a), query(a, "Model", "B3"), { text: body + "\n\n未核验：单位。" },
      ], { attachments: [a.path] });
      assert.equal(record.status, "partial");
      assert.match(record.reason, /未核验：单位/);
      assert.equal(record.text, body);
      assert.deepEqual(await openedCells(assistant), [destination(a, 111), destination(a, 33, "B3")]);
    });
  }
  for (const [name, reads, response] of [
    ["swapped references before the claims", ["B2", "B3"], "根据 Model!B3，收入为111；根据 Model!B2，净利润为33。"],
    ["only the year was read", ["B1"], "年份为2025年，见 Model!B1。"],
    ["no workbook read", [], "已查阅完毕。"],
  ]) {
    await t.test(`metric coverage: ${name}`, async () => {
      const { record } = await turn("请帮我列出收入和净利润", [
        ...reads.map(coord => query(a, "Model", coord)), { text: response },
      ], { attachments: [a.path] });
      assert.equal(record.status, "failed", JSON.stringify(record));
      assert.equal(record.text, "");
      assert.deepEqual(record.citations, []);
      assert.match(record.reason, /收入/);
      assert.match(record.reason, /净利润/);
    });
  }
  for (const [name, response] of [
    ["coordinated claims", "收入和净利润分别为111（Model!B2）和33（Model!B3）。"],
    ["metrics in column headings", "| 指标 | 收入 | 净利润 |\n| --- | --- | --- |\n| 数值 | 111（Model!B2） | 33（Model!B3） |"],
  ]) {
    await t.test(`metric coverage: ${name}`, async () => {
      const { record, assistant } = await turn("2025年收入和净利润是多少？", [
        query(a), query(a, "Model", "B3"), { text: response },
      ], { attachments: [a.path] });
      assert.equal(record.status, "completed", JSON.stringify(record));
      assert.equal(record.text, response);
      assert.deepEqual(record.citations.map(c => c.locator), ["Model!B2", "Model!B3"]);
      assert.deepEqual(await openedCells(assistant), [destination(a, 111), destination(a, 33, "B3")]);
    });
  }
  await t.test("a period and bold label do not drop a verified plain income value", async () => {
    const response = "2025年，**收入：** 111";
    const { record } = await turn("2025年收入和净利润各是多少？", [
      query(a, "WrongSheet"), query(a), { text: response },
    ]);
    assert.equal(record.status, "partial");
    assert.match(record.reason, /净利润/);
    assert.equal(record.text, response);
  });
  await t.test("period and punctuation do not hide an answered metric", async () => {
    const response = "2025年，收入为111，见 Model!B2。净利润为33，见 Model!B3。";
    const { record, assistant } = await turn("2025年收入和净利润各是多少？", [
      query(a, "WrongSheet"), query(a), query(a, "Model", "B3"), { text: response },
    ]);
    assert.equal(record.status, "completed");
    assert.equal(record.text, response);
    assert.deepEqual(await openedCells(assistant), [destination(a, 111), destination(a, 33, "B3")]);
  });
  await t.test("a verified value does not substantiate a second unsupported value for the same metric", async () => {
    const revenue = "收入为111，见 Model!B2。";
    const profit = "净利润为33，见 Model!B3。";
    const { record, assistant } = await turn("2025年收入和净利润各是多少？", [
      query(a), query(a, "Model", "B3"),
      { text: revenue + profit + "净利润约为99，见 Model!B3。" },
    ]);
    assert.equal(record.status, "partial");
    assert.match(record.reason, /净利润/);
    assert.equal(record.text, revenue + "\n" + profit);
    assert.deepEqual(await openedCells(assistant), [destination(a, 111), destination(a, 33, "B3")]);
  });
  for (const [layout, response] of [
    ["on one line", "见 `[A.xlsx]Model!B2`、`C2`。"],
    ["across a Markdown soft break", "见 `[A.xlsx]Model!B2`、\n`C2`。"],
  ]) {
    await t.test(`code-formatted shorthand ${layout} opens both cells after refresh`, async () => {
      const { record, assistant } = await turn("请给出两个单元格的出处。", [
        query(a), query(a, "Model", "C2"), { text: response },
      ]);
      assert.equal(record.status, "completed");
      assert.equal(record.text, response);
      const targets = [destination(a, 111), destination(a, 112, "C2")];
      assert.deepEqual(await openedCells({ role: "assistant", ...record }), targets);
      assert.deepEqual(await openedCells(assistant), targets);
    });
  }
});
