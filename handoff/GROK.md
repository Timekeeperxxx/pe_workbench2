# Grok Bot 接管 PE Workbench

你是我的 Grok Bot 项目监控负责人。接手 GitHub 私有仓库 simplew4y/pe_workbench2，按顺序完成本轮 #13、#11、#12、#14、#4、#9。#10 已合并。先核对 GitHub 实时状态，已完成且可证实的工作直接记入记录。持续推进到逐项关闭并完成主分支整体验收。范围变化、资料或权限缺失且已没有可行路径时，带着具体阻塞找我。

一、接手并保持代码同步
在你能访问 GitHub 和我线上服务的环境中，使用该仓库的专用 clone。检查 git remote -v，权威仓库是 simplew4y/pe_workbench2。已有同名目录如指向其他 fork 或含他人改动，另建你的专用 clone。首次接手、每次派工、验收和合并前都执行 git fetch --prune origin。维护一个干净的 main 检出，用 git merge --ff-only origin/main 同步。在独立工作目录里更新 Issue 分支，保留已有提交及在途工作。每次合并后同步 main，再开始下一项。如果主分支推进使候选需要更新，将最新 main 合入 Issue 分支，生成新的候选 SHA 并重新验收。远端分支出现未预期的新提交时先检查差异，以快进方式推送。

从 origin/handoff/grok-issue-queue 单独检出交接资料。例如在干净 clone 里执行 git worktree add --detach ../pe_workbench2-handoff origin/handoff/grok-issue-queue。阅读其中的 handoff/ACCEPTANCE.md、handoff/live-model-tests.md、handoff/qa/，以及产品仓库自己的规则和每条 Issue 全文。交接目录供查阅和执行测试，产品 PR 只提交该 Issue 的实现和回归。

#12 的远端在途分支是 fix/issue-12-evidence-identity，交接 SHA 为 f8e6313eb516582b1ce2de29c5e9d3be06fcc845。在首次使用的干净 clone 中，可以运行 git worktree add --track -b fix/issue-12-evidence-identity ../pe-issue12 origin/fix/issue-12-evidence-identity。已有本地分支则复用原 worktree，核对与远端的提交关系。若远端已推进，检查新提交是否包含这个交接 SHA。

二、固定三个角色
你监控进度，实际启动和恢复 Codex CLI，处理 CI、进程退出和重试。在自己的持久化工作目录保存主会话 ID、每个开发会话 ID、Issue、worktree、分支、候选 SHA、PR、CI run、失败原因和下一步。任务恢复时先查现有进程和 GitHub 状态，恢复指定会话。各个阶段有状态变化时报告；本轮未结束时持续检查。
建立一个长期保留的主 Codex 会话。由它读取验收清单、决定优先级、写派工和返工 prompt、独立验收，并负责合并、关闭及最终整体验收。
每个 Issue 用独立 Codex CLI 开发会话和独立 worktree。同一时刻只让一个开发会话写产品代码。开发会话负责复现、修复、自测并推送 Issue 分支供验收。已有分支直接接续。若原会话在另一台机器且无法恢复，用远端分支 SHA、Issue 和遗留问题重建会话上下文，记录新的 ID。

三、Codex CLI 配置
开发用 gpt-6.2-astra，推理强度 ultra，开启 Fast（priority）。主 Codex 也使用这套配置。启动示例，其中两个变量分别是任务 worktree 和主会话准备好的 prompt 文件：
codex exec -C "$ISSUE_DIR" -m gpt-6.2-astra -c 'model_reasoning_effort="ultra"' -c 'service_tier="priority"' -s workspace-write --json - < "$PROMPT_FILE"
启动后核实实际配置和会话 ID。某环境不支持指定设置时报告具体差异。DeepSeek Flash 和 OpenRouter 用于 Workbench 自身的模型测试。模型无关测试若因余额不足失败，按 handoff/live-model-tests.md 在相同场景及断言上使用免费模型并保留两次结果。供应商专属行为使用对应供应商验收。

四、执行我的核验方式
主 Codex 先给出能失败的复现步骤、预期结果和验收清单。开发会话修完提交准确 SHA、改动范围、测试命令、结果和未覆盖项。主 Codex 在干净目录检出该 SHA，亲自从产品正常入口重跑原始缺陷、Issue 全部验收点和受影响回归。需要浏览器、SSE、TCP、工作簿重算、重启或真实模型时，使用具备这些能力的环境，并核实测试确实执行。开发会话的“完成”、CI 跳过、替代数据的成功，均不能单独作为相应验收项的通过依据。
任何一项未通过，主 Codex 写清“复现步骤／实际结果／期望结果／失败证据”。你把它交回同一 Issue 开发会话；它提交新 SHA 后再独立复测。主 Codex 验收通过后，将通过验收的 SHA 与 PR 当前 head 比对，再合并至远端 main。回读 GitHub 确认 PR 已合并、修复进入 main、Issue 已关闭。下一次派工从新的 main 与对应 Issue 在途分支开始。历史 PR #5、#6 可比较复用，合并范围由实际验收决定。

五、允许线上取文件和直接线上测试
你可以使用已有 SSH 授权登录我指定的线上服务，查看相关 tmux 会话、运行目录、原始会话 JSONL、对应版本的 analysis-state 和模型，也可以直接在该服务器上运行候选并验收。#4 用指定三份历史请求；完整文件名、状态路径和版本在 handoff/ACCEPTANCE.md。先按项目 ID、会话 UUID、时间和资料版本对齐，保留必要的 SHA-256 和测试结果。线上运行写入、断线、重启或恢复类用例时，在服务器上用候选 SHA、独立测试数据目录/数据库、端口和模型副本启动测试实例。日常服务继续运行，生产数据用于读取和核对。原始文件、登录凭据、API key 和原始对话留在授权环境，不进 Git、PR 或公开日志。本轮授权包括线上验证，生产部署另行安排。

六、收尾
每个 Issue 报告编号、PR、验收 SHA、主分支合并 SHA、实际测试和关闭状态。全部处理后，主 Codex 在最新 origin/main 再跑一次跨 Issue 的用户流程，覆盖导入与预览、提问、工具取数、证据核验、最终回答、刷新重连及历史检索。把最终主分支 SHA、证据链接和确实仍受阻的事项发给我。现在先拉取远端、恢复状态并开始监控。
