---
name: task-flow
description: >-
  呼叫通用任務引擎的端到端入口流程。Use when a user wants an arbitrary repo task handled as a full flow: create or reuse an isolated worktree, run the orchestrator pipeline from intake through human gate, worker/reviewer execution, machine verification, optional local auto-commit, and safe worktree teardown. Use to resume a task-flow run that already has an orchestrator/manifest.json. Do not use for a single direct edit, a standalone commit, standalone worktree setup/teardown, push, PR creation, deploy, or any flow that should bypass intake, human gate, reviewer, or machine verification.
---

# task-flow

## 用途

把一個使用者需求交給「通用任務引擎」完整跑完。本站是入口 flow,負責準備工作區、呼叫 orchestrator、在合法停點與使用者互動,並在完成後視需求呼叫 commit / teardown 站。

本站不做任務實作、不自行拆解任務、不自行決定 routing。拆解與驗證地圖由 intake 產出;執行順序與狀態轉移由 orchestrator 透過 `cli.js` 決定。

## 角色邊界

- **task-flow**:入口協調。決定是否需要隔離 worktree、整理 commit context、呼叫後續技能、處理完成後收尾。
- **worktree-setup**:只建立或重用隔離 worktree,回傳 path / branch / scope。
- **orchestrator**:在目標 worktree 內讀寫 `orchestrator/manifest.json`,跑 intake → human gate → worker/reviewer → test → done/halt。
- **auto-commit**:只在 orchestrator `done` 後、且使用者或呼叫端要求本地 commit 時執行。
- **worktree-teardown**:只在 commit 成功後或使用者明確要求清理時執行,安全移除工作目錄。

不要把這些站的責任混在一起。尤其不要在 task-flow 內手寫 manifest 狀態、直接跑 worker、直接跑 test runner、或自行 approve 人類 gate。

## 輸入

從使用者需求或呼叫端取得:

- 原始需求文字。後續 reviewer 必須能看到這份原文。
- 目標 repo / worktree。預設使用目前工作目錄。
- `commitType` 與 `scope`。需要建立 worktree 或 commit 時必須有;缺少時用保守方式從需求推短 scope,無法安全推定才詢問使用者。
- `base` 分支(選填)。未提供時由 worktree-setup 使用目前分支。
- 是否要 commit。預設:若產生交付物且使用者沒有反對,在 orchestrator `done` 後呼叫 auto-commit。
- 是否要 teardown。預設:commit 成功後可安全呼叫 worktree-teardown,保留 task 分支與 journal 分支。

## 主流程

1. **確認執行位置**
   - 若使用者要求在目前工作樹直接跑,或已經位於某個 task worktree 且 `orchestrator/manifest.json` 存在,直接在目前目錄跑 orchestrator。
   - 否則呼叫 `worktree-setup`,用 `commitType` + `scope` 建立或重用隔離 worktree。後續所有 orchestrator / auto-commit 都在回傳的 `path` 中執行。

2. **呼叫 orchestrator**
   - 在目標 worktree 內使用 `$orchestrator`。
   - 若 `orchestrator/manifest.json` 已存在,把它視為唯一事實來源並續跑,不可重新 intake。
   - 若不存在,把使用者原始需求交給 orchestrator 進 intake。orchestrator 會建立 draft manifest、產出 intake 文件、跑 validate,並觸發人類 gate。

3. **處理 human gate / clarify**
   - orchestrator 回 `clarify` 時,把問題原樣交給使用者,拿到答覆後交回 orchestrator resume。
   - 人類 gate 出現時,呈現 intake analysis / tasks / verification map,尤其確認哪些任務是 `no-judge`。只有使用者明確同意後,才能依 orchestrator 的 resume 契約放行。
   - 使用者要求修改 intake 時,把修改意見交回 orchestrator,讓它重做 intake 並再次 gate。

4. **跑到終點**
   - orchestrator `done`:進入收尾。
   - orchestrator `halt`:停止,回報 reason 與 manifest / intake 文件位置,不要硬推。
   - orchestrator 因環境或震盪 clarify 停下:等使用者答覆,不要臆測。
   - 若回合在 orchestrator 長迴圈中斷,重入時先呼叫 orchestrator 讀 manifest 判定狀態;若已是 `done`,視為待收尾,直接續做 commit / teardown。

5. **本地 commit**
   - 只有在 orchestrator `done` 後執行。
   - 在目標 worktree `path` 內呼叫 `auto-commit`,傳入專案根目錄、`commitType`、最終 `scope`、`commitMode` 與過程紀錄清單。
   - `commitMode:"declared"` 時,必須額外傳入聲明交付清單(應進 commit 的交付檔路徑);文件交付物或明確檔案清單任務都走此模式。
   - 過程紀錄清單至少包含 `orchestrator/` 下的 intake 文件、重要 reviewer / test 摘要、manifest。交付物 commit 不應包含 `orchestrator/` 過程檔。
   - auto-commit 硬拒絕時,不要把流程標成已提交;向使用者回報原因與目前分支 / worktree。

6. **清理 worktree**
   - commit 成功且不需要立刻繼續修改時,可呼叫 `worktree-teardown`。
   - teardown 必須從主 checkout 或其他目錄執行,不要在要移除的 worktree 內執行。
   - 預設只移除 worktree,保留 task 分支與 `journal/<scope>`。

## commit context

需要建立 worktree 或 commit 時,先確定:

- `commitType`:依需求選 `feat` / `fix` / `refactor` / `docs` / `test` / `chore` 等 Conventional Commit type。
- `scope`:短、穩定、可當 branch scope 與 journal scope。若 worktree-setup 回傳 collision 尾碼,後續 commit 與 journal 必須沿用回傳的最終 `scope`。
- `ticketId`(選填):若使用者提供且專案慣例使用 ticket 作 scope,可把它作為 scope 或 commit metadata。
- `commitMode`:一般既有 repo 用 `default`;綠地第一個 commit 用 `initial`;需要提交文件交付物或明確檔案清單時用 `declared`。

scope 不由 worktree-setup 或 auto-commit 臆造。task-flow 是決定 scope 的站。

## 路徑與狀態

- 工作 manifest 固定是目標 worktree 的 `orchestrator/manifest.json`。
- `orchestrator/` 是過程目錄。讓 worker / reviewer / test 摘要都放在這裡,交付 commit 由 auto-commit 排除,必要時發到 journal。
- `.claude/skills` 是 skill 唯一實體;`.agents/skills` 只是 symlink。修改技能時只改 `.claude/skills`。
- 不建立額外 flow state 檔。可恢復狀態以 git worktree + branch + `orchestrator/manifest.json` 為準。

## 恢復流程

使用者要求 resume 時:

1. 找到目標 worktree。若使用者給 branch,可先用 `git worktree list` 找 path;找不到再呼叫 worktree-setup 重掛同 branch。
2. 進入該 path,確認 `orchestrator/manifest.json` 存在。
3. 呼叫 orchestrator 繼續跑。不要重建 manifest、不要重跑 intake,除非 orchestrator 自己因 blame / gate 要求重 intake。
4. 若 orchestrator 回報已 `done`,不要重跑任務;把這次重入視為收尾階段,依需求執行 auto-commit / teardown。

若 manifest 不存在,這不是 resume;回到主流程從 intake 開始。

## 拒絕與停手

在以下情況停下問使用者或回報阻塞:

- 使用者要求跳過 intake、人類 gate、reviewer、或可機器驗任務的真 test。
- 缺少會改變 worktree / commit 目標的關鍵資訊,且無安全預設。
- orchestrator 回 `halt`。
- auto-commit 或 teardown 硬拒絕。
- 需要 push、開 PR、deploy、刪 remote、花錢 API 等對外或不可輕易還原動作。本站全程 local,不做 remote 操作。

## 交付格式

完成後回報:

- 需求是否跑到 orchestrator `done`。
- worktree path、branch、scope。
- commit hash / message(若有 commit)。
- journal 分支(若 auto-commit 發佈過程紀錄)。
- teardown 是否移除 worktree。
- 若停在 human gate / clarify / halt,列出使用者下一步要看的檔案或要回答的問題。

不要把 `result.json` / worker JSON 回報區塊當成交付物給使用者;它們只是 orchestrator 內部交換格式。

## 自檢

- 已使用隔離 worktree或明確遵循使用者指定的目前工作樹。
- worktree-setup 回傳的最終 `scope` 已被後續 auto-commit / journal 沿用。
- orchestrator 是唯一寫 manifest 狀態與決定下一步的站。
- human gate 沒有被自動 approve;使用者看過驗證地圖後才放行。
- 能機器驗的任務沒有用 reviewer 主觀判定取代真 test。
- commit 只在 orchestrator `done` 後發生,且全程 local。
- teardown 只在沒有未提交交付物時執行,預設保留分支與 journal。
