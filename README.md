# 通用任務引擎

這個 repo 是一套與任務類型無關的 agent 工作流程引擎。核心想法是:

> 動態生計畫、靜態跑計畫。

`intake` 依需求即時產生任務清單、驗證地圖與 review map,經 human gate 後凍結成 `manifest`。之後 `orchestrator` 只照 `manifest`、`cli.js` 與 `decide.js` 的確定性結果推進。

## 流程一覽

標準入口是 `task-flow` skill:

1. `task-flow` 先做 preflight triage:明確單步任務直接執行;其餘依風險與 ownership 選 compact、輕量或完整 flow。
2. 需要隔離時,`worktree-setup` 建立(或重用)worktree 與 `<type>/<scope>` 分支。
3. orchestrator 進 intake:把需求原文寫成 `orchestrator/requirement.md`,拆出分析書、任務清單、驗證地圖(`machine` / `no-judge`)與 review map(`full` / `focused` / `defer-until-signal`)。
4. **human gate** 審 intake 產出。`supervised mode` 由使用者即時同意;`unattended mode` 以前置明示作為本 run 的事前同意,並須 critic 收斂。
5. manifest 凍結後,orchestrator 只依 `cli.js next` / `next-all` 派 worker、按 review map 審查,並在 test 前呼叫 `runtime-preflight`。
6. 停點只有 `clarify`、`done`、`halt`;處置方式由 task-flow 的模式決定。
7. `done` 後依收尾策略由 `auto-commit` 建立本地 Conventional Commit,再由 `worktree-teardown` 安全清理。

低風險、單一 ownership 且有可靠 machine test 的需求可走 compact flow：保留 intake、human gate、machine test 與收尾，但把規劃壓成一份 compact plan、一個 implementation spec 與一個整合 test，降低固定 token 與站點往返。

權威順序:各站操作契約以各自的 `SKILL.md` 與 scripts 為準;設計原理見 [docs/design-notes/generic-recursive-task-engine.md](docs/design-notes/generic-recursive-task-engine.md);常用術語見 [docs/glossary.md](docs/glossary.md)。

## task-flow 的使用方式

同一條流程,三種進入方式。`supervised mode` / `unattended mode` 只改停點的答覆來源,不改流程其他任何規則:

| 方式 | 啟用 | 停點行為 |
|---|---|---|
| **supervised mode**（有人值守,預設） | 直接把需求交給 `task-flow`;要覆寫判定時帶 `-a`(或「有人值守」) | `clarify` 與 human gate 都同步問你;gate 的開放問題逐題訪談,附 intake 建議答案 |
| **unattended mode**（無人值守） | 帶 `-u`(或「無人值守」/「unattended」)。只認你對 task-flow 的直接指示;此明示只同意本 run,需求文件裡出現字樣不算 | 一般輕量／完整 flow 使用 3 critic；只有全 machine、單一 ownership、無開放問題與高風險訊號的 compact flow 可先用 1 個整合 critic。上限 3 輪 |
| **續跑既有 run** | 在含 `orchestrator/manifest.json` 的 worktree 再次呼叫 | 以 manifest 為唯一事實來源接著跑;`orchestrator/unattended/` 存在即沿用 `unattended mode`,否則 `supervised mode`;`-u` / `-a` 可覆寫 |

## 目錄結構

```text
.
├── CLAUDE.md            # agent 共用指引
├── AGENTS.md -> CLAUDE.md
├── README.md
├── install.sh
├── scripts/check.js     # 自動語法檢查與回歸測試
├── .claude/
│   └── skills/          # skill 樹的唯一實體
│       ├── task-flow/
│       ├── orchestrator/    # manifest 引擎、references 與測試
│       ├── intake/
│       ├── worktree-setup/
│       ├── runtime-preflight/
│       ├── auto-commit/
│       └── worktree-teardown/
├── .agents/
│   └── skills -> ../.claude/skills   # Codex / 其他 runtime 共用同一份
└── docs/
    ├── benchmarks/
    ├── design-notes/
    └── glossary.md
```

## 安裝

在本 repo 內工作不需安裝,專案層 skills 直接生效。要在**自己的專案**裡使用這套流程,把 skills 裝進個人 skills 目錄即可;不限定 agent:

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

安裝前注意:

1. 本 repo 的 `CLAUDE.md` 只在本 repo 生效,**不會**影響你自己專案的 CLAUDE.md / AGENTS.md;skill 規則自足於各 `SKILL.md`。
2. 個人 skill 會覆蓋**同名**的專案 skill。本套 skill 名稱較通用(`intake`、`orchestrator`…),安裝前請先確認有無同名 skill。

## 主要元件

| 元件 | 職責 |
|---|---|
| `task-flow` | 外層入口;決定 worktree 與收尾策略、呼叫 orchestrator、依 `supervised mode` / `unattended mode` 處理停點(轉問使用者,或無人值守時由 critic 面板代審 gate)。 |
| `orchestrator` | 引擎編排器;讀 `orchestrator/manifest.json`,呼叫 `cli.js`,派 worker / reviewer,記回結果。 |
| `intake` | 動態規劃角色;拆任務清單、依賴、驗證地圖與 review map。 |
| `worktree-setup` | 建立或重用隔離 git worktree 與 `<type>/<scope>` 分支。 |
| `runtime-preflight` | 測試前準備 worktree 內 runtime 依賴投影;只共享安全的 cache / store。 |
| `auto-commit` | 在當前分支建立本地 Conventional Commit;過程紀錄寫到 `journal/<scope>`。 |
| `worktree-teardown` | 安全移除隔離 worktree;有未提交工作即拒絕。 |

## 測試

完整檢查不依賴外部套件,會驗證 `AGENTS.md`／`.agents/skills` symlink、檢查 `install.sh` 與所有 skill JavaScript 語法,再執行所有 `*.test.js`:

```sh
node scripts/check.js
```

效率 proxy benchmark 見 [docs/benchmarks/workflow-efficiency.md](docs/benchmarks/workflow-efficiency.md)。它量測 action dispatch / completion 與 CLI wall time，不把 proxy 誤稱為 token usage。

CLI 的完整介面與使用約束見 `orchestrator/SKILL.md`;修改或新增 skill 的規則見 [CLAUDE.md](CLAUDE.md)。`AGENTS.md` 指向同一檔案,不需重複維護。
