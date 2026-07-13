---
name: orchestrator
description: 與任務類型無關的通用任務引擎編排器。讀磁碟上的 manifest 當唯一事實來源,呼叫 cli.js 決定下一步,把實際工作委派給 worker 子代理,產出依 human gate 核准的 review map 做 full / focused / deferred 審查,能機器驗的節點經 runtime-preflight 準備環境後實跑 test,結果寫回 manifest 直到完成或被安全護欄擋下。任務拆解、驗證地圖與 review map 由 intake 針對該次需求即時產生、經 human gate 後凍結。Use when the user wants to drive an arbitrary requirement end to end through a planned, verified task list (intake → human gate → worker/review-map → machine-verify where possible → done), or to resume a half-finished run; do not use to do a single task's work directly or to make routing decisions by hand.
---

# orchestrator

## 用途

**與任務類型無關的通用任務引擎編排器**:接任意使用者需求,一路驅動到完成。任務的拆解與驗收標準不預先寫死,而是在 `intake` 階段針對該次需求即時產生、經 human gate 後凍結。

三個 subagent 角色,都不是引擎的一部分,由你(orchestrator)派工:

- **intake** — 解析需求、拆成任務清單、產出「分析書 + 任務清單 + 驗證地圖 + review map」;經 human gate 後凍結成 manifest。
- **worker** — 執行單一任務節點、產出成品;**不得私自再拆解**。
- **reviewer** — 對著需求原文(非 intake 轉述的衍生規格)審 worker 的產出,採對抗式 framing。

引擎(`cli.js` / `decide.js`)只認得通用欄位,不認得任何任務領域或角色語意。`spec.skill` 是 worker 角色標籤(`intake` / `worker`),你依它派一個扮演該角色的 subagent——不是去呼叫某個 skill 檔。測試前的 runtime 依賴準備依 `runtime-preflight` skill 的規則,由 test worker 在 worktree 內執行。

有委派能力時,你不做任何一步的實際工作、不判斷下一步,只循環四件事:

1. 問 `cli.js` 下一步是什麼
2. 把對應的 worker subagent 委派出去做(produce 站依 review map 決定審查深度)
3. 把結果寫回 manifest
4. 重複,直到 `done` 或 `halt`

`done` 只代表 manifest 任務圖已全數 verified;done 後的 commit / teardown 收尾是 `task-flow` 的責任,不是 orchestrator 的 routing 節點。

## 鐵則

- **唯一事實來源是 manifest 檔,不是你的記憶**。但你經由 `cli.js` 的輸出讀它:派工的機械輸入以 action 的 `brief` 為準,不要自己讀 manifest 重新組裝,也不要每輪把 manifest 全文讀進對話(診斷引擎異常時才直接讀檔)。
- **記回只接受引擎發派過的 action**:`next` / `next-all` 發派時把授權寫進 `orchestration.leases`,`produce` / `test` 沒有對應授權會被 exit 1 擋下。順序固定是「先問、再派、再記回」,不可先做完再補問。授權只在當輪有效:下一次發派會整批重發、作廢殘留,不可囤舊授權跨輪記回。
- **routing 與平行度都不由你判斷**,一律來自 `cli.js next`(單一)或 `cli.js next-all`(批次)。`next-all` 的 `actions` 是 manifest `depends_on` 圖確定性算出的「此刻互相獨立、可同時跑」集合——平行多少 = 這一輪 `actions` 的大小,你不准自己讀 `depends_on` 去推。
- **扁平:worker 不得私自再拆解任務**。需要重新拆解時,唯一的路是退回重 `intake`(reviewer 把 `blame` 指向 intake spec、`altitude:spec`);重 intake 一樣經 human gate,不繞過人。
- **不准手動編輯 manifest 狀態**。狀態一律只能透過 `cli.js produce` / `cli.js test` / `resume` 改。只有三種例外可碰結構/設定欄位——bootstrap 建 draft、重 intake 的結構修補、使用者要求補做機器驗收——做法見 `$SKILL_DIR/references/manifest-authoring.md`;新增節點只能以 `pending` 初始化。
- **有委派能力時,worker 一律委派給子代理,主 agent 不親手跑任何一站**。你只做協調(問 cli.js、派 worker / reviewer、寫 `result.json`、記回 manifest);worker 只讀輸入、產出自己的成品,不碰 manifest、不接著跑下一步。`result.json` 由你寫,不是 worker。
- **worker 產出依 human gate 核准的 review map 審查**(執行時讀 `references/action-protocol.md`)。`review_map` 未列的 spec(或整份缺失)一律預設 `full`,降級只能明確 opt-in。reviewer 全程不碰 manifest / `result.json` / routing,只挑戰、不代改;通過或合法 defer 後你才記 `ok:true`。
- **一站完成不是停點,不得中途結束回合**。記回輸出已帶 `next` 與 `continue`:`continue:true` ⇒ 同回合續跑;`continue:false` ⇒ 依停點處置。合法停點只有三種:`clarify`(含 human gate)、`done`、`halt`;其餘任何「先回報進度再說」的收尾都是中斷流程的 bug(進度可用一行帶過,但說完必須接著做)。
- **test-runner worker 只能經 `cli.js test` 驅動**。任何 `manifest.tests[*].runner` 指到的測試只能由 `next` / `next-all` 吐出的 `test` action 觸發、結果只能經 `cli.js test` 記回——這樣 `environment` 失敗才會觸發 `m.block`→`clarify` 停下問人。絕不可為了「補跑一下」直接呼叫測試 worker、把它寫出的 .md 摘要當數。manifest 沒有對應 test 節點時要補做機器驗收,見 `references/manifest-authoring.md`。
- **確定性**:同樣的 manifest → `cli.js` 一定給同樣的 action,不同廠商的 agent 照此跑結果就一致。動態只活在 intake 規劃這一步(含退回重 intake),每次 intake 版本都必須經 human gate;同一版 manifest 一旦放行,後面全是確定性執行,不可自行重規劃。

## 何時使用

- 使用者要把一個需求「從頭跑完整條任務清單,到所有 spec 驗證通過(`done`)」
- 使用者要接續一個跑到一半的流程(manifest 已存在)→ 直接進迴圈,`cli.js` 會從斷點接著挑

不要在這些情境使用:

- 使用者只要單獨做某一件事 → 直接委派一個 worker subagent
- 使用者要你憑感覺決定任務順序 → 順序由 manifest 的 `depends_on` + `cli.js` 決定
- 使用者要「完整入口流程」含隔離 worktree、commit 或 teardown → 使用 `task-flow`;orchestrator 只跑 manifest 到 `done` / `halt` / `clarify`

## 路徑約定(先讀這段,後面所有指令都用這些變數)

這個 skill 被叫起來時,harness 會告訴你它的 **base directory**(形如 `…/skills/orchestrator`)。以下用 `$SKILL_DIR` 代表它:

- **CLI 腳本**:`$SKILL_DIR/scripts/cli.js`(同層還有 `decide.js`,你只直接呼叫 `cli.js`)
- **gate 呈現工具**:`$SKILL_DIR/scripts/gate-view.js`(唯讀,把 manifest 渲染成 human gate 用的一頁 Markdown;只在 `kind:"review"` 時用)
- **task packet 工具**:`$SKILL_DIR/scripts/task-packet.js`(唯讀,從 `orchestrator/task-packets.json` 取單一 spec 的自足派工資料)
- **manifest 範本**:`$SKILL_DIR/references/manifest.example.json`(只讀的結構參考,不要改)
- **manifest 撰寫 / 修補指南**:`$SKILL_DIR/references/manifest-authoring.md`(bootstrap、重 intake 結構修補、補做機器驗收時先讀它)
- **工作用 manifest**:`orchestrator/manifest.json`(寫在使用者專案工作目錄下,不是 skill 目錄內)。下面用 `$MANIFEST` 代表它。
- **需求原文**:`orchestrator/requirement.md`(bootstrap 時把使用者原始需求原封不動寫入)。所有 worker / reviewer 委派都帶這個路徑,避免靠 session 記憶或主 agent 轉述續跑。

跑指令前先把 `$SKILL_DIR` 換成 harness 給你的實際絕對路徑(帶引號,路徑可能含空白)。

## CLI interface（按需讀）

每次準備呼叫 `cli.js` 或解析 action 前讀 [references/cli-interface.md](references/cli-interface.md)。只在同一回合已載入、且回傳形狀未變時沿用，避免反覆載入。

## 處理步驟(主迴圈)

工作用 manifest 固定為 `$MANIFEST`(= `orchestrator/manifest.json`,寫在使用者專案工作目錄下)。

1. **準備 manifest**:
   - 若 `$MANIFEST` 已存在 → 直接沿用,不重建,不重新規劃(這就是「接續跑到一半的流程」)。進主迴圈前若同目錄缺 `orchestrator/requirement.md`,停下請使用者補原始需求;不要用 session 記憶或 intake 轉述假裝原文。煙霧測試 / 試跑用的範本 manifest 不適用此檢查。
   - 若不存在,且只是要煙霧測試 / 試跑 → 把範本複製成工作檔(`mkdir -p orchestrator && cp "$SKILL_DIR/references/manifest.example.json" "$MANIFEST"`),不需要建立 `requirement.md`。
   - 若不存在,且使用者給的是真實需求 → 先把使用者原始需求原封不動寫成 `orchestrator/requirement.md`(需求含圖片(設計圖 / 截圖)時,把圖存進 `orchestrator/requirement-assets/` 並在 requirement.md 標注對應位置;後續派工引用原圖,不以文字轉述取代),再讀 `$SKILL_DIR/references/manifest-authoring.md` 照「intake:動態規劃」執行:先明講 scout 判斷並照做(派幾個、各探哪個面向,或不派＋理由;規則見該文件)、派 intake、寫 draft manifest、`validate`、記回 intake produce 觸發 human gate,放行後凍結。不要為同一份 draft 再跑第二次 intake。
   - 一律對 `$MANIFEST` 操作,不要動到 example 檔。
2. **問這一輪能跑什麼**(依執行模型擇一):平行用 `cli.js next-all`(一批互相獨立的 action),序列用 `cli.js next`(單一)。解析印出的 JSON。
3. **派工**:
   - `produce` → 先讀 `references/action-protocol.md`,再跑 `task-packet.js orchestrator/task-packets.json <specId>` 取得自足 packet，連同 action `brief` 與 requirement 路徑交給 worker；不要手動從多份 Markdown 擷取或叫 worker 讀整份 intake。focused reviewer 使用 packet 的 requirement clause mapping，只讀對應原文條款；full reviewer 才讀完整原文。packet 帶 `tag` 時先讀對應 notes；引用 UI checklist / 圖片時一併附上。重做時把 `last_failure` / `fix_target` 交給 worker，並要求簡短 handoff summary。收斂版或合法 defer 才記回。
   - `test` → 委派測試 worker 時,要求它先執行 `runtime-preflight/scripts/preflight.js --root <worktree>`；cache hit 直接沿用，cache miss 才由 runner install。再對 `verifies` 的 spec 實跑 `test.runner`，並把 preflight JSON 納入 evidence。test worker 屬機械執行角色,無特別標記時視同 `tier:"low"`。preflight 或測試環境失敗時回 `{ "pass": false, "altitude": "environment", "reason": "...", "evidence": {...} }`,不可歸咎到 spec。
   - 平行時:把 `next-all` 這批 `actions` 的 produce/test 在同一回合一起委派、同時跑,等整批回來。
   - **收結果,序列記回**:每個子代理回報後,依 `references/action-protocol.md` 覆核末尾 JSON 區塊並轉錄成一個 `result.json`,逐一 `cli.js produce` / `cli.js test` 記回——一個一個寫,不要平行寫。produce 成功記回後,若該任務帶 `tag`,把 worker 的 handoff summary 蒸餾進 `orchestrator/notes/<tag>.md`(由你寫,worker 不碰):固定三節——Guideline(本 tag 慣例,就地更新,上限 40 行)、Prototype(範本實作的檔案路徑)、Pitfalls(一行一條,append)——寫入時修剪超限內容。
   - `clarify` → 停下把 `question` 問使用者(不可自動重跑、不可臆測答案)。拿到答覆後寫 `answer.json`(`{ "answer": "<使用者答覆>", "reopen": "pending" }`;要保留原失敗脈絡讓 worker 針對性重做時用 `"failed"`)→ `cli.js resume $MANIFEST <clarify 回的 spec 或 test> answer.json` → 回第 2 步。(`kind:"environment"` 回的是 `test`,resume 後只重跑該 test、不重做任何 spec;其餘回的是 `spec`。)
     - **`kind:"review"`(human gate)是 clarify 的特例,不是失敗**:該 spec 宣告了 `review_gate: true`(本引擎用在 intake),引擎在它產出成功後停下,等使用者查看再繼續。先跑 `node "$SKILL_DIR/scripts/gate-view.js" $MANIFEST` 取得一頁式渲染(任務波次、每節點裁判類型、no-judge / defer 標記與升級訊號、警示清單),把它連同 clarify 裡列的產出檔路徑與重點摘要——**尤其是驗證地圖與 review map**——給使用者,討論到他明確表態。同意續跑 → `answer.json` 寫 `{ "approve": true }` → `cli.js resume`(spec 不重做、直接進 produced/verified);要求修改 → 寫 `{ "answer": "<修改意見>" }` → `cli.js resume`(reopen 重做,意見成為修補指示),重做成功後引擎再次 gate,直到使用者同意。同意來源只能是使用者——即時表態,或由呼叫端帶進、範圍涵蓋本 run 的事前明示同意;兩者皆無時 `approve` 不合法,嚴禁自行寫 `{"approve":true}` 跳過 human gate。
   - `done` → 結束,把 `done` 回交呼叫端。不要在 orchestrator 內自行 commit / teardown;若本輪是由 `task-flow` 啟動,由 task-flow 的收尾策略接手。
   - `halt` → 結束,回報 reason(達回合上限 maxTurns)。
4. **立即回到第 2 步**(同一回合內接續);回合只在 `done` / `halt` / `clarify` 三種 action 上結束(`clarify` 不是終局,`resume` 後續跑)。

## 執行模型:兩條獨立的軸

執行粒度與執行者是兩件事,分開判斷:

- **執行粒度**:`cli.js next-all` = 一次取出本輪所有可平行 action;`cli.js next` = 一次取出單一 action。預設用 `next-all`;只有 runtime 不支援平行委派、使用者要求單步 debug、或正在縮小故障範圍時,才退回 `next`。粒度只影響一次派幾個 action,不改變誰執行 action。
- **執行者**:有宿主原生委派能力時,每個 produce/test 一律委派給子代理;主 agent 只協調、轉錄結果、寫回 manifest。序列模式也是一次委派一個 action,不是主 agent inline 執行。委派必須走宿主原生能力,不得用 `claude -p` / `codex exec` 另開外部程序。若 runtime 有委派能力但需要使用者授權且尚未授權,停下請使用者授權;不要 inline。只有 runtime 完全沒有委派能力時,才進入 inline 退化模式。

不論使用 `next-all` 或 `next`,都必須遵守:

1. **順序與平行度只來自 manifest**:`next-all.actions` 是唯一可平行派工清單。若某個 phase 必須等前一 phase 全部完成,intake 必須用 `depends_on` 明確表達 phase boundary,不可依賴 `next` 的序列行為保序。
2. **狀態序列寫回**:子代理不碰 manifest;主 agent 收到回報後,逐一用 `cli.js produce` / `cli.js test` 寫回。
3. **委派輸入要完整**:每次委派都明確提供 `orchestrator/requirement.md` 路徑、該任務的描述切片、上游 `outputs` 檔案路徑與 `env` 事實;produce 站也要要求 worker 回報 handoff summary,供 focused reviewer 當索引。
4. **依賴獨立不等於檔案獨立**:`next-all` 只保證 action 在 `depends_on` 上互不依賴;平行 worker/test 仍必須寫入不重疊輸出或只做唯讀操作。需要平行安全時,intake 用任務拆分與 `allowed_outputs` 約束檔案 ownership。同一 spec 的多個 test 因常共用 runner / 工作目錄,`decideAll` 已每輪每 spec 只取一個 test 序列化,你不必特別處理。

## action protocol（按需讀）

收到 `produce` / `test` action、需要派 reviewer、組裝 `result.json`、判斷 `altitude` / `blame`，或診斷震盪時，先讀 [references/action-protocol.md](references/action-protocol.md)。該檔包含 review depth、收斂、結果 schema、誠實性守門、歸咎與終止規則。不要在 bootstrap、單純 routing 或 human gate 時預載。

## 交付前自檢

只檢查鐵則未覆蓋、實務上最常做歪的幾件事:

- 重做 `failed` spec 時已把 `last_failure` 與 `fix_target` 當修補指示交給 worker,沒讓它盲目重跑
- 每份 `result.json` 都從 worker 回報的 JSON 區塊覆核轉錄而來(blame 存在、altitude 合法、pass 附實跑 evidence),沒有自由創作,也沒替沒附證據的 pass 補造 evidence
- 收到 `clarify` 時已把 `question` 原樣問使用者、未臆測答案;`kind:"review"` 時已附上 `gate-view.js` 的一頁渲染,並把分析書 / 任務清單 / **驗證地圖 / review map** 交給使用者討論到明確表態,`{"approve":true}` 只在取得使用者同意(即時表態,或呼叫端帶進的事前明示)後才寫
- 委派 `test` 時已要求 test worker 先依 `runtime-preflight` 準備環境;能機器驗的節點都實跑
- bootstrap 派 intake 前已明講 scout 判斷(派或不派都附一句理由),沒有默默略過
- 帶 `tag` 的任務派工時已指示先讀 `orchestrator/notes/<tag>.md`;UI 任務已附設計圖與 `intake-ui-checklist.md`;produce 成功記回後 notes 已蒸餾更新
- 全程只在 `clarify` / `done` / `halt` 三種停點結束過回合;`done` 後未自行 commit / teardown(交回 `task-flow`)
