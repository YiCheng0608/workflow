# 通用任務引擎

這個 repo 放的是一套與任務類型無關的 agent 工作流程引擎。核心想法是:

> 動態生計畫、靜態跑計畫。

`intake` 依使用者需求現場拆出任務清單、驗證地圖與 review map,經過人類 gate 後凍結成 `manifest`;之後由 `orchestrator` 只照 `manifest`、`cli.js` 與 `decide.js` 的確定性結果推進。引擎不認得任務領域,只認通用欄位、依賴圖與狀態旗標。

## 流程一覽

標準入口是 `task-flow` skill,它把一個需求串完整條流程:

1. `worktree-setup` 建立(或重用)隔離 worktree 與 `<type>/<scope>` 分支。
2. orchestrator 進 intake:把需求原文寫成 `orchestrator/requirement.md`,拆出分析書、任務清單、驗證地圖(`machine` / `no-judge`)、review map(`full` / `focused` / `defer-until-signal`)。
3. **人類 gate**:使用者審 intake 產出——不只確認要做哪些任務,也確認接受哪些任務沒有客觀裁判;沒有明確同意不得放行。
4. manifest 凍結後靜態執行:orchestrator 每輪只問 `cli.js next` / `next-all`,派 worker 產出、依 review map 審查;能機器驗的節點先由 `runtime-preflight` 準備依賴環境再實跑 test,結果經 `cli.js` 記回。
5. 停點只有三種:`clarify`(問使用者,可續跑)、`done`(全部 verified)、`halt`(撞安全護欄)。
6. `done` 後依收尾策略由 `auto-commit` 做本地 Conventional Commit(過程紀錄發孤兒分支 `journal/<scope>`),再由 `worktree-teardown` 安全清理。

各站的完整契約(輸入、產出、邊界、拒絕條件)以各自的 `SKILL.md` 為準;設計原理見 [docs/design-notes/generic-recursive-task-engine.md](docs/design-notes/generic-recursive-task-engine.md)。

## 目錄結構

```text
.
├── CLAUDE.md            # agent 共用指引(AGENTS.md 為 symlink)
├── .claude/
│   └── skills/          # skill 樹的唯一實體
│       ├── task-flow/
│       ├── orchestrator/    # SKILL.md + references/ + scripts/(cli.js、decide.js、tests)
│       ├── intake/
│       ├── worktree-setup/
│       ├── runtime-preflight/
│       ├── auto-commit/
│       └── worktree-teardown/
├── .agents/
│   └── skills -> ../.claude/skills   # Codex / 其他 runtime 共用同一份
└── docs/
    └── design-notes/
        └── generic-recursive-task-engine.md
```

## 主要元件

| 元件 | 職責 |
|---|---|
| `task-flow` | 外層入口;決定 worktree 與收尾策略、呼叫 orchestrator、轉問 human gate。 |
| `orchestrator` | 引擎編排器;讀 `orchestrator/manifest.json`,呼叫 `cli.js`,派 worker / reviewer,記回結果。 |
| `intake` | 動態規劃角色;拆任務清單、依賴、驗證地圖與 review map。 |
| `worktree-setup` | 建立或重用隔離 git worktree 與 `<type>/<scope>` 分支。 |
| `runtime-preflight` | 測試前準備 worktree 內 runtime 依賴投影;只共享安全的 cache / store。 |
| `auto-commit` | 在當前分支建立本地 Conventional Commit;過程紀錄發 `journal/<scope>`。 |
| `worktree-teardown` | 安全移除隔離 worktree;有未提交工作即拒絕。 |

## 測試

引擎回歸測試不依賴框架,全綠時 exit code 為 `0`:

```sh
node .claude/skills/orchestrator/scripts/cli.test.js
node .claude/skills/orchestrator/scripts/decide.test.js
```

改過 `cli.js` / `decide.js`:先 `node --check` 過語法,再跑上面兩支。CLI 的完整介面與使用約束見 `orchestrator/SKILL.md`;修改或新增 skill 的規則見 [CLAUDE.md](CLAUDE.md)。
