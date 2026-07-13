# CLAUDE.md(Claude / Codex 等 agent 共用指引;`AGENTS.md` 為指向本檔的 symlink)

回話一律使用 **繁體中文（台灣用語）**。技術術語、工具名、角色名與專有名詞可保留原文；需要釐清時，再以繁體中文簡短說明。

核心術語優先保留原文: `manifest`、`worktree`、`human gate`、`supervised mode`、`unattended mode`、`review map`、`runtime`、`intake`、`worker`、`reviewer`、`orchestrator`、`commit`、`journal`。同一概念不要混用中文譯名;名詞解釋見 [docs/glossary.md](docs/glossary.md)。

## 這個 repo 是什麼

一個**與任務類型無關的通用任務引擎**:`manifest`(磁碟上的唯一事實來源)+ `cli.js`(I/O adapter)+ `decide.js`(純函數決策)。引擎不認得任務領域,只讀 manifest 通用欄位、照 `depends_on` 圖與旗標推進。orchestrator 讀 manifest、呼叫 `cli.js`、派工收結果;實際工作交給三個 subagent 角色(非引擎的一部分):

- **intake** — 拆需求成任務清單 + 驗證地圖 + review map,經 **human gate** 後凍結成 manifest。整條流程唯一的動態步驟。gate 答覆來源依 task-flow 的 `supervised mode` / `unattended mode` 決定。
- **worker** — 執行單一任務節點、產出成品;**不得私自再拆解**(要重拆的唯一路是退回重 intake)。
- **reviewer** — 依 review map 對著需求原文審 worker 產出,採對抗式 framing;不代改、不碰 manifest、不決定 routing。

一句話:**動態生計畫、靜態跑計畫** —— intake 依需求即時產生 manifest,經 human gate 凍結後,全由引擎照旗標確定性推進;能機器驗的節點先做 runtime-preflight 再實跑 test,無客觀裁判的誠實標記。

權威順序:操作契約以各 skill 的 `SKILL.md` 與 scripts 為準;設計原理見 [docs/design-notes/generic-recursive-task-engine.md](docs/design-notes/generic-recursive-task-engine.md);常用術語見 [docs/glossary.md](docs/glossary.md)。本節只作定位。

## 目錄與雙 runtime

- `.claude/skills/` — Claude Code 用,是 skill 樹的**唯一實體**。
- `.agents/skills/` — Codex / 其他 agent 用,是指向 `../.claude/skills` 的 **symlink**。兩 runtime 共用同一份;改 `.claude/skills/` 即同時生效。
- 單一 skill 的版面:`SKILL.md`(契約)＋選用的 `references/`(細節層與範本)／`scripts/`(deterministic runner 與測試)。引擎程式只在 `orchestrator/scripts/`。

## 常用指令

- 完整檢查:`node scripts/check.js`。runner 會驗證共用 symlink、檢查 `install.sh` 與所有 skill JavaScript 語法,再自動執行 `*.test.js`;新增測試不必更新指令清單。
- skills 樹是單一實體、`.agents/skills` 為 symlink;改 `.claude/skills/` 即同時供兩 runtime 使用,無需另行同步。

## 改 / 新增 skill 的鐵則

**skill 是寫給「之後讀它來執行的 agent」看的,不是寫給「現在跟你討論的人」看的。** 每次補充內容前,用這把尺逐句檢查:

> 這句話只有當時在場討論過的人才看得懂嗎?是的話,它就不該進 skill。

最常見的三種「討論殘渣」,看到就刪:

1. **對著對話裡的質疑寫辯解** — 例:「設計如此,不是缺陷」「你不必、也不該…」。讀者沒有那個疑問;skill 只陳述規則,不對想像中的懷疑者辯護。
2. **敘述改動前的歷史狀態** — 例:「已出現三份措辭不同的宣告(開始漂移)」。那是 git 的工作,過陣子就過時、變成錯的。
3. **把還沒做的未來點子停在文件裡** — 例:把「之後也許要加的 critic」整段寫進操作型參考。未實作的想法去 issue / 設計筆記,別讓讀者每次都得判斷「這段是真的還假的」。

該寫的只有:**這一站吃什麼、產什麼、邊界在哪、什麼情況拒絕。** 理由精煉到一句帶過,不要把推導過程整段搬進來。
