# 剩余 Issue 和验收入口

本轮仓库为 `simplew4y/pe_workbench2`。从对应远端分支接手。先查询实时状态，本表中的 SHA 是交接时可核验的代码锚点。经核实，#11 候选以 #13 候选为父提交，#12 工作提交以 #11 候选为父提交。依次合入主线后再建立后续 PR，可保持每个 PR 的审查范围清楚。

| Issue | 从哪里接手 | 主会话需要核验的事 |
|---|---|---|
| #10 | PR #15 已合并，合并提交 `12bbb17ebae56ebd13337361c2ec8f8ce8160c07` | 保留多指标交付回归 |
| #13 | PR #16，`fix/issue-13-delivery-recovery`，`2145500173b522c360749ee449db2a246739dc0d` | 在固定 SHA 实测默认聊天与 AG-UI 的正文、引用、状态、重放、重连和服务进程重启；含并发编辑的两个会话分别拿到各自结论 |
| #11 | `fix/issue-11-evidence-budget`，`2380603f4b45aa1b547dafface0261eecc53dd98` | 验证整个模型请求预算、最新成功证据、检索覆盖、尚未解决的错误、调用配对和原始 JSONL |
| #12 | `fix/issue-12-evidence-identity`，`f8e6313eb516582b1ce2de29c5e9d3be06fcc845` | 9 个产品文件的在途代码，本次新增交接用例实跑 21 通过、2 失败；继续返工和补仓库回归 |
| #14 | 基于前置 Issue 整合后的主线开发 | 普通问答、后台补证据、用户主动复核，以及合法的“上一轮”“修正后的完整回答”等文字。检查正式记录、实时、刷新和下一轮历史检索 |
| #4 | 核对当前主线实现和 PR #5；使用下表指定的三个真实会话 | 首句回答问题，首屏可见复核项，数字和相应版本状态一致，报告默认折叠，高亮最多四处且附文字标签 |
| #9 | 从更新后的主线建立分支。线上原始说明可查 `/workspace/projects/_chief/tasks/model-actuals-writeback/BRIEF.md` | 通过实际导入、预览、确认写回、资料版本和还原入口，验证仅写权威材料可核对的历史字面量 |

## 已有 CI

- #13 验证分支为 `ci/verify-issue-13-2145500`。首轮交付 97 项、协议 189 项通过，使用真实浏览器和 TCP；通用 E2E 遇到运行器缺 LibreOffice，于验证分支补装并重跑同一候选。查看最新结论。[重跑](https://github.com/simplew4y/pe_workbench2/actions/runs/44397084306)
- #11 验证分支为 `ci/verify-issue-11-2380603`。预算回放和 Chrome 重启专项已跑过。第一次运行综合回归遇到仓库记录过的行情时区问题；标准命令为 `TZ=Asia/Shanghai npm run test:systemic`，依据在 `docs/project-fact-memory.md`。查看整套重跑结果。[重跑](https://github.com/simplew4y/pe_workbench2/actions/runs/44399233924)
- 以上验证分支只存工作流。读取工作流中实际 checkout 的产品 SHA，并检查测试步骤和断言都已执行。若产品提交发生变化，重新验证新 SHA。

## 独立验收工具

在候选 checkout 按锁文件安装 npm 依赖。现有 CI 使用 Node 24.16、Python 3.12。按用例准备 openpyxl、Playwright/Chrome、LibreOffice Calc；其余 Python 依赖按对应仓库脚本安装。下面的 `QA` 指向交接 worktree 的 `handoff/qa` 绝对路径。在要验收的产品 checkout 中执行。

```sh
# #11 验收
node "$QA/context-budget.mjs"
npm run test:context-budget

# #12 验收
node "$QA/financial-evidence.mjs" "$PWD"
npm run test:cell-cite

# #14 合成工作簿、真实工具和会话交付链；模型输出固定以便比较
node "$QA/answer-review.mjs" "$PWD"

# #4 从候选代码生成离线布局检查页，输出路径须为新文件
python3 "$QA/presentation-viewport.py" --repo "$PWD" "$OUT_DIR/viewport.html"

# #9 在一个新建或空目录生成合成 XLSX 和两份披露
python3 "$QA/make-writeback-fixture.py" "$FIXTURE_DIR"
```

#11 独立用例在 5,000 token 窗口下，从估算的 7,999 和 10,052 分别降至 1,139 和 1,053。额外跑仓库固定夹具，检查长旧正文、派生依赖、范围摘要及原始会话文件保持完整。外部脚本只替换模型传输层。

#12 在交接 SHA 仍失败的两条是：“其他假设未核验，收入为 789 亿元”被放行，当轮收入证据实际为 100；用户只问净利润，回答却引用真实收入，交付检查仍放行。对照用例包括未核验说明放在后面的情况、省略指标名时按问题继承、答出收入且证据匹配。务必把修复后的回归纳入产品仓库，复测合法区间、换算、派生以及提交前的纠错和部分交付。

#14 独立脚本在 #11 的固定 SHA 上实际为 26 项通过、25 项失败。重点是用户主动复核时保留旧数、新数、原因及出处，同回合内部补证据时草稿留在工具过程。合成工作簿的 PL!B8 仅用于固定回归；真实模型按材料版本和其自身单元格重新核对。前置 #12 整合后重测一次基线。

#9 合成数据的目标格为 IS!C4，收入从 100 变为 120。即使同公司同期间，加入第二份数值 122 的冲突披露后也应退出可写清单。检查取消、重复确认、并发版本变化、旧引用过期与还原、公式格、相邻年份误判、WACC、预测和情景排除。生成夹具后还要通过产品入口上传、确认和重开验证。线上验证使用资料副本。

## #4 线上真实回放

离线布局页打开后，选择自己保存在授权环境的 JSON 数组。每个元素含正式回答字符串 `text` 和当轮状态对象 `state`，可选 `report`（报告 Markdown）与 `turnStartedAt`。输出每个案例的首个复核项可见性、折叠状态和高亮等测量。第一句语义、财务数字与完整原始请求回放还须由主 Codex 核验。

审计记录的项目根目录为 `/root/autodl-tmp/pe_workbench2/projects`。每条 JSONL 在相应项目的 `.pi/sessions/` 中，状态相对目录在 `exports/investment-model/` 下。部署可能迁移，以 tmux 会话的工作目录和数据库记录核实实际位置。

| 案例 | 项目 ID | 会话文件 | 状态子目录及版本 |
|---|---|---|---|
| 长鑫 | `p-1e1b42a2` | `2026-10-24T06-42-15-434Z_a138cf55-db0d-428b-b204-6aa14624ac37.jsonl` | `高盛-长鑫-Model-20260904/analysis-state.json`，按轮次核对 v1、v2 |
| NVIDIA（项目名“测试项目”） | `p-ae94d09a` | `2026-10-29T04-54-46-211Z_ae33ca8f-4956-41de-90b6-37ca4c18edc5.jsonl` | `1783838815979_NVIDIA+Corporation_NVDA.OQ_2025_Jul_15/analysis-state.json`，v1 |
| 腾讯（项目名“复现测试-腾讯-可删”） | `p-8c88b7b5` | `2026-11-02T07-25-24-911Z_65bba35a-fe77-4913-8ee4-467b343705ec.jsonl` | `腾讯Model/analysis-state.json`，首轮 v5，后续有 v6、v7 |

读出当轮完整用户请求，追到对应的模型、报告及状态版本并核对内容哈希。保留原件，在候选版本建立测试会话、回放、在 1440×900、1280×720、390×844 检查真实聊天可见区与完整报告。历史旧状态可能尚无 presentation；旧状态重绘与用新代码重放同一原始请求分别记录。已有两条其他真实历史回合在 1440×900 的可见区下沿为 y=772，首个复核项从 y=1158、1134 才开始。它们提供可复现的布局基线，三个指定案例仍需单独验收。
