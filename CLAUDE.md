# CLAUDE.md(Claude / Codex 等 agent 共用指引;`AGENTS.md` 為指向本檔的 symlink)

回話一律 **100% 繁體中文**。

## 這個 repo 是什麼

一個**與任務類型無關的通用任務引擎**:**manifest(磁碟上的唯一事實來源)+ `cli.js`(I/O adapter)+ `decide.js`(純函數決策)**。引擎不認得任何任務領域,只讀 manifest 通用欄位、照 `depends_on` 圖與旗標確定性推進。orchestrator 讀 manifest、呼叫 `cli.js`、派工收結果;實際工作交給三個 subagent 角色(非引擎的一部分):

- **intake** — 拆需求成任務清單 + 驗證地圖 + review map,過**人類 gate** 後凍結成 manifest。整條流程唯一的動態步驟。gate 答覆來源依 task-flow 的值守模式(有人值守親審為預設;無人值守由使用者本次明示啟用,critic 面板代審、人審移到事後審計)。
- **worker** — 執行單一任務節點、產出成品;**不得私自再拆解**(要重拆的唯一路是退回重 intake)。
- **reviewer** — 依 review map 對著需求原文審 worker 產出,採對抗式 framing;不代改、不碰 manifest、不決定 routing。

一句話:**動態生計畫、靜態跑計畫** —— intake 依需求現生 manifest 過人類 gate,凍結後全由引擎照旗標確定性推進;能機器驗的節點先做 runtime-preflight 再實跑 test,無客觀裁判的誠實標記。

完整設計與設計原理見 [docs/design-notes/generic-recursive-task-engine.md](docs/design-notes/generic-recursive-task-engine.md)——**該筆記為唯一事實來源,本節僅作定位、不再展開**(避免與筆記漂移)。

## 目錄與雙 runtime

- `.claude/skills/` — Claude Code 用,是 skill 樹的**唯一實體**。
- `.agents/skills/` — Codex / 其他 agent 用,是指向 `../.claude/skills` 的 **symlink**(`.agents/skills -> ../.claude/skills`)。**兩 runtime 共用同一份:改 `.claude/skills/` 即同時改了兩邊,沒有「另一邊要同步」這回事。**
- 單一 skill 的版面:`SKILL.md`(契約)＋ `references/`(SKILL.md 卸下的細節層,以及 orchestrator 的 manifest 結構範本;引擎 `cli.js`/`decide.js` 全程不讀)＋ `scripts/`(只有 orchestrator 有的引擎程式)。

## 常用指令

- 引擎與工具回歸測試(無框架,全綠 `exit 0`):
  - `node .claude/skills/orchestrator/scripts/cli.test.js`
  - `node .claude/skills/orchestrator/scripts/decide.test.js`
  - `node .claude/skills/orchestrator/scripts/gate-view.test.js`
- 改過 `scripts/` 下的程式:先 `node --check` 過語法,再跑上面的 test。(skills 樹是單一實體、`.agents/skills` 為 symlink,改完即兩 runtime 生效,無需另行同步。)

## 改 / 新增 skill 的鐵則

**skill 是寫給「之後讀它來執行的 agent」看的,不是寫給「現在跟你討論的人」看的。** 每次補充內容前,用這把尺逐句檢查:

> 這句話只有當時在場討論過的人才看得懂嗎?是的話,它就不該進 skill。

最常見的三種「討論殘渣」,看到就刪:

1. **對著對話裡的質疑寫辯解** — 例:「設計如此,不是缺陷」「你不必、也不該…」。讀者沒有那個疑問;skill 只陳述規則,不對想像中的懷疑者辯護。
2. **敘述改動前的歷史狀態** — 例:「已出現三份措辭不同的宣告(開始漂移)」。那是 git 的工作,過陣子就過時、變成錯的。
3. **把還沒做的未來點子停在文件裡** — 例:把「之後也許要加的 critic」整段寫進操作型參考。未實作的想法去 issue / 設計筆記,別讓讀者每次都得判斷「這段是真的還假的」。

該寫的只有:**這一站吃什麼、產什麼、邊界在哪、什麼情況拒絕。** 理由精煉到一句帶過,不要把推導過程整段搬進來。
