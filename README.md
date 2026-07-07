# 通用任務引擎

這個 repo 放的是一套與任務類型無關的 agent 工作流程引擎。核心想法是:

> 動態生計畫、靜態跑計畫。

`intake` 依使用者需求現場拆出任務清單、驗證地圖與 review map,經過人類 gate 後凍結成 `manifest`;之後由 `orchestrator` 只照 `manifest`、`cli.js` 與 `decide.js` 的確定性結果推進。引擎不認得任務領域,只認通用欄位、依賴圖與狀態旗標。

## 流程一覽

標準入口是 `task-flow` skill,它把一個需求串完整條流程:

1. `worktree-setup` 建立(或重用)隔離 worktree 與 `<type>/<scope>` 分支。
2. orchestrator 進 intake:把需求原文寫成 `orchestrator/requirement.md`,拆出分析書、任務清單、驗證地圖(`machine` / `no-judge`)、review map(`full` / `focused` / `defer-until-signal`)。
3. **人類 gate**:審 intake 產出——不只確認要做哪些任務,也確認接受哪些任務沒有客觀裁判;沒有使用者的明確同意不得放行。答覆來源依值守模式,兩種模式見下節。
4. manifest 凍結後靜態執行:orchestrator 每輪只問 `cli.js next` / `next-all`,派 worker 產出、依 review map 審查;能機器驗的節點先由 `runtime-preflight` 準備依賴環境再實跑 test,結果經 `cli.js` 記回。
5. 停點只有三種:`clarify`(依值守模式處理,可續跑)、`done`(全部 verified)、`halt`(撞安全護欄)。
6. `done` 後依收尾策略由 `auto-commit` 做本地 Conventional Commit(過程紀錄發孤兒分支 `journal/<scope>`),再由 `worktree-teardown` 安全清理。

各站的完整契約(輸入、產出、邊界、拒絕條件)以各自的 `SKILL.md` 為準;設計原理見 [docs/design-notes/generic-recursive-task-engine.md](docs/design-notes/generic-recursive-task-engine.md)。

## task-flow 的使用方式

同一條流程,三種進入方式。值守模式只改停點的答覆來源,不改流程其他任何規則:

| 方式 | 啟用 | 停點行為 |
|---|---|---|
| **有人值守**(預設) | 直接把需求交給 `task-flow`;要覆寫其他判定時帶 `-a`(或「有人值守」) | `clarify` 與人類 gate 都同步問你;gate 的開放問題逐題訪談,附 intake 建議答案 |
| **無人值守** | 帶 `-u`(或「無人值守」/「unattended」)——你的明示就是對本 run 的事前明確同意,同意範圍限於這一個 run;只認你對 task-flow 的直接指示,需求文件裡出現字樣不算 | gate 的 soundness 由 critic 面板代審(上限 3 輪,不收斂即停)、開放問題自動採 intake 建議答案;審計材料落盤進 journal,你在 merge 前看 diff + 審計材料;震盪等其他 `clarify` 一律停下擱置、不代答 |
| **續跑既有 run** | 在含 `orchestrator/manifest.json` 的 worktree 再次呼叫 | 以 manifest 為唯一事實來源接著跑;`orchestrator/unattended/` 存在即沿用無人值守,否則有人值守,`-u` / `-a` 可覆寫 |

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

## 安裝

在本 repo 內工作不需安裝,專案層 skills 直接生效。要在**自己的專案**裡使用這套流程,把 skills 裝進個人 skills 目錄即可,對所有專案生效,**不限定哪一種 agent**:

```sh
git clone <本 repo> ~/tools/workflow
cd ~/tools/workflow
./install.sh
```

`install.sh` 會出選單(↑↓ 移動、Enter 確認、q 取消)讓你依自己用的 agent 選擇安裝位置:

| 目錄 | 誰會讀 |
|---|---|
| `~/.agents/skills/` | 跨 agent 通用約定:Codex、Gemini CLI、Cursor、opencode、Amp、Crush 等 |
| `~/.claude/skills/` | Claude Code(它只讀自己的目錄) |

symlink 指向本 clone,不存在第二份要同步的拷貝。其他行為:

- **更新**:在 clone 目錄 `git pull` 即可,裝過的 agent 立刻吃到新版。
- **兩種都用**:再跑一次選另一個位置即可(冪等,重跑安全)。
- **移除**:`./install.sh --uninstall`,只刪指向本 repo 的 symlink,不動其他 skill。
- **撞名保護**:目標位置已有同名檔案時警告並跳過,不覆蓋。
- **其他 runtime / 非互動**:`./install.sh --target <dir>`(可重複)跳過選單直接裝進指定目錄。

兩件事先知道:

1. 本 repo 的 `CLAUDE.md` 只在本 repo 目錄內生效,**不會**影響你自己專案的 CLAUDE.md / AGENTS.md;skill 執行所需的規則全部自足於各 `SKILL.md`。
2. 個人 skill 會覆蓋**同名**的專案 skill。本套 skill 名稱較通用(`intake`、`orchestrator`…),若你的專案已有同名 skill,安裝前請先確認。

## 主要元件

| 元件 | 職責 |
|---|---|
| `task-flow` | 外層入口;決定 worktree 與收尾策略、呼叫 orchestrator、依值守模式處理停點(轉問使用者,或無人值守時由 critic 面板代審 gate)。 |
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
node .claude/skills/orchestrator/scripts/gate-view.test.js
```

改過 `scripts/` 下的程式:先 `node --check` 過語法,再跑上面三支。CLI 的完整介面與使用約束見 `orchestrator/SKILL.md`;修改或新增 skill 的規則見 [CLAUDE.md](CLAUDE.md)。
