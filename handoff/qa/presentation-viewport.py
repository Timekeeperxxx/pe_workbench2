#!/usr/bin/env python3
"""Build an offline #4 layout check from a candidate checkout with npm dependencies installed.

    python3 handoff/qa/presentation-viewport.py --repo . viewport.html

Open viewport.html in a desktop browser and select an authorized local UTF-8 JSON array.
Each object needs text (the original answer string) and state (the matching analysis-state
object). Optional report is the same-turn report Markdown string. Optional turnStartedAt
is the original turn's ISO timestamp or epoch milliseconds. Use array positions to identify
cases. The HTML contains candidate assets only. The selected input stays in browser memory.

Results measure one completed answer from the top of its thread in CSS pixels. A real
first review row must fit entirely in the visible thread. Null means unavailable. Full
acceptance also requires replaying each original request, reading the first sentence, and
reconciling the delivered figures and units with the matching state.
"""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess


ENTRY = r"""
import {renderThread} from './ui/chat/renderer.js';
import {state} from './ui/state/store.js';

window.measureCase = async function(input) {
  if (typeof window.marked?.parse !== 'function') throw Error('Local marked did not load');
  const reportPath = 'exports/report.md';
  const hasReport = typeof input.report === 'string';
  window.fetch = async url => {
    const [path, query] = String(url).split('?');
    if (!hasReport || path !== '/api/file' || new URLSearchParams(query).get('path') !== reportPath) {
      throw Error('Unexpected resource requested');
    }
    return {ok: true, status: 200, text: async () => input.report};
  };
  state.files = [];
  state.messages = [{
    role: 'assistant', status: 'completed', turnId: 'viewport',
    text: input.text, analysisState: input.state, turnStartedAt: input.turnStartedAt,
    tools: hasReport ? [{name: 'write', detail: reportPath, status: 'done'}] : [],
  }];
  renderThread(false);
  // The local fetch and text promises resolve before this task resumes.
  await new Promise(resolve => setTimeout(resolve, 0));
  await document.fonts?.ready;
  const thread = document.querySelector('#thread');
  thread.scrollTop = 0;
  const article = thread.querySelector('article.assistant');
  if (!article) throw Error('Missing assistant article');
  const box = thread.getBoundingClientRect();
  const visible = {
    top: Math.max(0, box.top + thread.clientTop),
    left: Math.max(0, box.left + thread.clientLeft),
    bottom: Math.min(innerHeight, box.top + thread.clientTop + thread.clientHeight),
    right: Math.min(innerWidth, box.left + thread.clientLeft + thread.clientWidth),
  };
  // The placeholder for a state without review items also has an li.
  const first = article.querySelector('.review-card li');
  const row = first?.querySelector('strong') ? first.getBoundingClientRect() : null;
  const wholeRow = !!row && row.width > 0 && row.height > 0
    && getComputedStyle(first).visibility === 'visible'
    && row.top >= visible.top && row.bottom <= visible.bottom
    && row.left >= visible.left && row.right <= visible.right;

  const toggle = article.querySelector('[data-report-toggle]');
  const report = article.querySelector('[data-report-body]');
  const marks = [...article.querySelectorAll('.hl-decision, .hl-review')];
  const labeled = marks.filter(el => el.textContent.trim().startsWith(
    el.matches('.hl-review') ? '需复核：' : '关键判断：'
  )).length;
  const verdict = input.state.presentation?.verdict;
  const meta = article.querySelector('.verdict-card .framework-meta')?.textContent || '';
  const hasLabel = value => !!value && meta.split('·').some(part => part.trim() === value);
  return {
    viewport: [innerWidth, innerHeight],
    threadTop: Math.round(visible.top), threadBottom: Math.round(visible.bottom),
    reviewTop: row ? Math.round(row.top) : null, reviewBottom: row ? Math.round(row.bottom) : null,
    firstReviewRowFullyVisible: wholeRow,
    presentationRendered: !!article.querySelector('.framework-presentation'),
    verdictStatusMatchesState: hasLabel(verdict?.status),
    verdictIdentityMatchesState: hasLabel(verdict?.value_identity),
    reportSupplied: hasReport, reportLoaded: hasReport ? !!report?.querySelector('.report-md') : null,
    reportCollapsed: toggle ? toggle.getAttribute('aria-expanded') === 'false' : null,
    reportBodyClipped: report ? report.scrollHeight > report.clientHeight
      && ['hidden','clip'].includes(getComputedStyle(report).overflowY) : null,
    highlights: marks.length, labeledHighlights: labeled,
    highlightsWithinFour: marks.length <= 4, allHighlightsLabeled: marks.length === labeled,
  };
};
"""

PAGE = r"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src about:; form-action 'none'; base-uri 'none'">
<title>#4 离线首屏复核</title></head><body><h1>#4 离线首屏复核</h1>
<p>选择有权使用的本地 JSON 数组。每项含 text（原回答）和 state（当轮状态对象），可含 report（报告正文）及 turnStartedAt（原轮次起始时间）。输出按输入顺序编号，坐标单位为 CSS 像素。</p>
<p>本页测量已完成回复的渲染。完整验收还需重放原始请求、核对首句和当轮状态中的数字及单位。</p>
<label>本地案例 <input id="source" type="file" accept=".json,application/json"></label>
<pre id="results" aria-live="polite"></pre><script>
const shell = __SHELL__;
async function measure(input, width, height) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:absolute;left:-10000px;top:0;border:0';
  frame.width = width; frame.height = height;
  const loaded = new Promise(resolve => frame.onload = resolve);
  frame.srcdoc = shell;
  document.body.appendChild(frame);
  try {
    await loaded;
    return await frame.contentWindow.measureCase(input);
  } finally { frame.remove(); }
}
async function run(cases, output) {
  if (!Array.isArray(cases) || !cases.length) throw Error('输入应为非空数组');
  for (const [index, item] of cases.entries()) {
    if (!item || typeof item.text !== 'string' || !item.state || typeof item.state !== 'object'
        || Array.isArray(item.state) || ('report' in item && typeof item.report !== 'string')) {
      throw Error('第 ' + (index + 1) + ' 项格式有误');
    }
    for (const [w, h] of [[1440,900], [1280,720], [390,844]]) {
      const row = await measure(item, w, h);
      output.textContent += JSON.stringify({case: index + 1, ...row}) + '\n';
    }
  }
}
const source = document.getElementById('source');
source.onchange = async () => {
  const file = source.files[0], output = document.getElementById('results');
  if (!file) return;
  source.disabled = true;
  output.textContent = '';
  try {
    let cases;
    try { cases = JSON.parse(await file.text()); } catch { throw Error('文件须为有效的 UTF-8 JSON'); }
    await run(cases, output);
  } catch (err) { output.textContent += 'ERROR: ' + err.message; }
  finally { source.value = ''; source.disabled = false; }
};
</script></body></html>"""


def build(repo):
    modules = repo / "node_modules"
    esbuild = modules / ".bin" / ("esbuild.cmd" if os.name == "nt" else "esbuild")
    bundle = subprocess.run(
        [str(esbuild), "--bundle", "--format=iife", "--log-level=error"],
        cwd=repo, input=ENTRY, text=True, encoding="utf-8", stdout=subprocess.PIPE, check=True,
    ).stdout
    marked = (modules / "marked/lib/marked.umd.js").read_text(encoding="utf-8")
    shell = (repo / "index.html").read_text(encoding="utf-8")
    shell = re.sub(r"<script\b[^>]*>.*?</script\s*>", "", shell, flags=re.I | re.S)

    def inline_style(match):
        css = (repo / match[1]).resolve()
        css.relative_to(repo)
        return "<style>" + css.read_text(encoding="utf-8") + "</style>"

    shell, styles = re.subn(r'<link rel="stylesheet" href="([^"]+)">', inline_style, shell)
    if not styles or "</body>" not in shell:
        raise ValueError("Candidate index.html is missing stylesheets or body")
    scripts = "".join("<script>" + re.sub("</script", r"<\\/script", js, flags=re.I)
                      + "</script>" for js in (marked, bundle))
    shell = shell.replace("</body>", scripts + "</body>")
    return PAGE.replace("__SHELL__", json.dumps(shell).replace("<", r"\u003c"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="candidate checkout (default: cwd)")
    parser.add_argument("output", type=Path, help="new offline HTML file")
    args = parser.parse_args()
    page = build(args.repo.resolve())
    with args.output.open("x", encoding="utf-8") as dest:
        dest.write(page)
