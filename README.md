# 通用任務引擎

這個 repo 放的是一套與任務類型無關的 agent 工作流程引擎。核心想法是:

> 動態生計畫、靜態跑計畫。

`intake` 依使用者需求現場拆出任務清單、驗證地圖與 review map,經過人類 gate 後凍結成 `manifest`;之後由 `orchestrator` 只照 `manifest`、`cli.js` 與 `decide.js` 的確定性結果推進。引擎不認得任務領域,只認通用欄位、依賴圖與狀態旗標。

完整設計原理見 [docs/design-notes/generic-recursive-task-engine.md](docs/design-notes/generic-recursive-task-engine.md)。README 只整理目前流程與日常操作入口。

## 目前流程

標準入口是 `task-flow` skill。它負責把一個使用者需求交給整條流程,並在必要時協調隔離 worktree、orchestrator、commit 與 teardown。

1. **建立或重用隔離工作區**
   - 預設用 `worktree-setup` 建立獨立 git worktree。
   - 分支名為 `<type>/<scope>`,例如 `feat/dashboard`。
   - 全程 local,不 push、不設 upstream、不碰 remote。

2. **啟動或續跑 orchestrator**
   - 工作 manifest 固定在目標 repo / worktree 的 `orchestrator/manifest.json`。
   - 若 manifest 已存在,視為唯一事實來源並從斷點續跑。
   - 若不存在,orchestrator 先進 intake。

3. **intake 動態規劃**
   - bootstrap 時先把使用者原始需求原封不動寫成 `orchestrator/requirement.md`;後續 worker / reviewer 都讀這份需求原文。
   - intake 只做規劃,不實作、不跑測試、不寫 manifest 狀態。
   - 產出四份 gate 可審文件:
     - `orchestrator/intake-analysis.md`
     - `orchestrator/intake-tasks.md`
     - `orchestrator/intake-verification.md`
     - `orchestrator/intake-review-map.md`
   - 驗證地圖逐任務標記 `machine` 或 `no-judge`。
   - review map 逐任務標記 `full` / `focused` / `defer-until-signal` 與升級條件。

4. **人類 gate**
   - 使用者檢查 intake 的分析書、任務清單、驗證地圖與 review map。
   - 重點不是只確認「要做哪些任務」,也要確認「接受哪些任務沒有客觀裁判」。
   - 沒有使用者明確同意,不得自行 approve。

5. **凍結 manifest 後靜態執行**
   - orchestrator 每輪只問 `cli.js next` 或 `cli.js next-all`。
   - `produce` action 派 worker 做單一任務節點。
   - 每個 worker 產出依 review map 走完整 reviewer、聚焦 reviewer,或在低風險且有可靠機器驗證時於 produce 前合法 defer。
   - `test` action 必須透過 `cli.js test` 記回真實測試證據。
   - worker 不得私自再拆任務;要重拆只能退回重 intake,且再次經過人類 gate。

6. **停點**
   - `clarify`:需求、環境、震盪或人類 gate 需要使用者答覆。
   - `done`:全部 spec verified,流程完成。
   - `halt`:撞到安全護欄,停止並回報原因。

7. **完成後收尾**
   - 需要 commit 時,`auto-commit` 在目前 worktree 產生本地 Conventional Commit。
   - 過程紀錄可發到孤兒分支 `journal/<scope>`,不混進交付分支。
   - 需要清理時,`worktree-teardown` 只在沒有未提交交付物時移除 worktree;預設保留 task 分支與 journal 分支。

## 目錄結構

```text
.
├── CLAUDE.md
├── AGENTS.md -> CLAUDE.md
├── .claude/
│   └── skills/
│       ├── task-flow/
│       ├── orchestrator/
│       ├── intake/
│       ├── worktree-setup/
│       ├── auto-commit/
│       └── worktree-teardown/
├── .agents/
│   └── skills -> ../.claude/skills
└── docs/
    └── design-notes/
        └── generic-recursive-task-engine.md
```

`.claude/skills/` 是 skill 樹的唯一實體。`.agents/skills` 是 symlink,指向同一份內容;改 `.claude/skills/` 就同時影響 Claude Code、Codex 與其他讀 `.agents/skills` 的 runtime,不需要同步第二份。

## 主要元件

| 元件 | 職責 |
|---|---|
| `task-flow` | 對使用者需求的外層入口;決定是否建 worktree、呼叫 orchestrator、處理 human gate、完成後視需要 commit / teardown。 |
| `orchestrator` | 通用任務引擎編排器;讀 `orchestrator/manifest.json`,呼叫 `cli.js`,派 worker / reviewer,依 review map 記回 produce / test 結果。 |
| `intake` | 動態規劃角色;把需求拆成扁平任務清單、依賴、驗證地圖與 review map。 |
| `worktree-setup` | 建立或重用隔離 git worktree 與 `<type>/<scope>` 分支。 |
| `auto-commit` | 在目前分支建立本地 Conventional Commit;可把過程紀錄發到 `journal/<scope>`。 |
| `worktree-teardown` | 安全移除隔離 worktree;用 `git status` 扣掉 `orchestrator/` 過程噪音判斷是否可移除。 |

## Orchestrator CLI

`orchestrator` 的引擎腳本在:

```text
.claude/skills/orchestrator/scripts/cli.js
.claude/skills/orchestrator/scripts/decide.js
```

常用介面:

```sh
node .claude/skills/orchestrator/scripts/cli.js next orchestrator/manifest.json
node .claude/skills/orchestrator/scripts/cli.js next-all orchestrator/manifest.json
node .claude/skills/orchestrator/scripts/cli.js produce orchestrator/manifest.json <specId> <result.json>
node .claude/skills/orchestrator/scripts/cli.js test orchestrator/manifest.json <testId> <result.json>
node .claude/skills/orchestrator/scripts/cli.js resume orchestrator/manifest.json <specId-or-testId> <answer.json>
node .claude/skills/orchestrator/scripts/cli.js validate orchestrator/manifest.json
```

狀態變更只能透過 `produce` / `test` / `resume` 寫回。除了 bootstrap、重 intake 的受控結構修補、或使用者明確要求補機器驗收之外,不要手動改 manifest 狀態。

## 測試

目前引擎回歸測試不依賴測試框架,全綠時 exit code 為 `0`:

```sh
node .claude/skills/orchestrator/scripts/cli.test.js
node .claude/skills/orchestrator/scripts/decide.test.js
```

改過 `cli.js` 或 `decide.js` 時,先跑語法檢查,再跑回歸測試:

```sh
node --check .claude/skills/orchestrator/scripts/cli.js
node --check .claude/skills/orchestrator/scripts/decide.js
node .claude/skills/orchestrator/scripts/cli.test.js
node .claude/skills/orchestrator/scripts/decide.test.js
```

## 維護規則

- `orchestrator/manifest.json` 是流程唯一事實來源;不要用 agent 記憶或外部摘要取代它。
- 流程順序與平行度只來自 `cli.js next` / `next-all`。
- 能機器驗的任務必須實跑測試,不能用 reviewer 的主觀判定代替。
- 無客觀裁判的任務要在驗證地圖誠實標為 `no-judge`。
- worker 只做單一節點,不得私自再拆任務。
- reviewer 只審產出,不代改、不碰 manifest、不決定 routing。
- 過程產物放在 `orchestrator/` 底下,不要混進交付 commit。
- 對 remote 的操作,例如 push、開 PR、deploy,不屬於這條自動流程。

## 修改或新增 skill

skill 是寫給之後讀它來執行的 agent,不是寫給當下討論的人。內容應聚焦:

- 這一站吃什麼。
- 這一站產什麼。
- 邊界在哪。
- 什麼情況要拒絕或停下問人。

避免把討論殘渣、歷史狀態或未實作的未來點子寫進 skill。設計推導放設計筆記或 issue;操作契約留在 skill。
