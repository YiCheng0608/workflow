---
name: orchestrator
description: 與任務類型無關的通用任務引擎編排器。讀磁碟上的 manifest 當唯一事實來源,呼叫 cli.js 決定下一步,把實際工作委派給 worker 子代理,產出依人類 gate 核准的 review map 做 full / focused / deferred 審查,能機器驗的節點經 runtime-preflight 準備環境後實跑 test,結果寫回 manifest 直到完成或被安全護欄擋下。任務拆解、驗證地圖與 review map 由 intake 針對該次需求現生、過人類 gate 後凍結。Use when the user wants to drive an arbitrary requirement end to end through a planned, verified task list (intake → human gate → worker/review-map → machine-verify where possible → done), or to resume a half-finished run; do not use to do a single task's work directly or to make routing decisions by hand.
---

# orchestrator

## 用途

**與任務類型無關的通用任務引擎編排器**:接任意使用者需求,一路驅動到完成。任務的拆解與驗收標準不預先寫死,而是在 `intake` 階段針對該次需求現生、過人類 gate 後凍結。

三個 subagent 角色,都不是引擎的一部分,由你(orchestrator)派工:

- **intake** — 解析需求、拆成任務清單、產出「分析書 + 任務清單 + 驗證地圖 + review map」;過人類 gate 後凍結成 manifest。
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
- **扁平:worker 不得私自再拆解任務**。需要重新拆解時,唯一的路是退回重 `intake`(reviewer 把 `blame` 指向 intake spec、`altitude:spec`);重 intake 一樣過人類 gate,不繞過人。
- **不准手動編輯 manifest 狀態**。狀態一律只能透過 `cli.js produce` / `cli.js test` / `resume` 改。只有三種例外可碰結構/設定欄位——bootstrap 建 draft、重 intake 的結構修補、使用者要求補做機器驗收——做法見 `$SKILL_DIR/references/manifest-authoring.md`;新增節點只能以 `pending` 初始化。
- **有委派能力時,worker 一律委派給子代理,主 agent 不親手跑任何一站**。你只做協調(問 cli.js、派 worker / reviewer、寫 `result.json`、記回 manifest);worker 只讀輸入、產出自己的成品,不碰 manifest、不接著跑下一步。`result.json` 由你寫,不是 worker。
- **worker 產出依人類 gate 核准的 review map 審查**(見「reviewer 迴圈」)。`review_map` 未列的 spec(或整份缺失)一律預設 `full`,降級只能明確 opt-in。reviewer 全程不碰 manifest / `result.json` / routing,只挑戰、不代改;通過或合法 defer 後你才記 `ok:true`。
- **一站完成不是停點,不得中途結束回合**。記回輸出已帶 `next` 與 `continue`:`continue:true` ⇒ 同回合續跑;`continue:false` ⇒ 依停點處置。合法停點只有三種:`clarify`(含人類 gate)、`done`、`halt`;其餘任何「先回報進度再說」的收尾都是中斷流程的 bug(進度可用一行帶過,但說完必須接著做)。
- **test-runner worker 只能經 `cli.js test` 驅動**。任何 `manifest.tests[*].runner` 指到的測試只能由 `next` / `next-all` 吐出的 `test` action 觸發、結果只能經 `cli.js test` 記回——這樣 `environment` 失敗才會觸發 `m.block`→`clarify` 停下問人。絕不可為了「補跑一下」直接呼叫測試 worker、把它寫出的 .md 摘要當數。manifest 沒有對應 test 節點時要補做機器驗收,見 `references/manifest-authoring.md`。
- **確定性**:同樣的 manifest → `cli.js` 一定給同樣的 action,不同廠商的 agent 照此跑結果就一致。動態只活在 intake 規劃這一步(含退回重 intake),每次 intake 版本都必須經人類 gate;同一版 manifest 一旦放行,後面全是確定性執行,不可自行重規劃。

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
- **manifest 範本**:`$SKILL_DIR/references/manifest.example.json`(只讀的結構參考,不要改)
- **manifest 撰寫 / 修補指南**:`$SKILL_DIR/references/manifest-authoring.md`(bootstrap、重 intake 結構修補、補做機器驗收時先讀它)
- **工作用 manifest**:`orchestrator/manifest.json`(寫在使用者專案工作目錄下,不是 skill 目錄內)。下面用 `$MANIFEST` 代表它。
- **需求原文**:`orchestrator/requirement.md`(bootstrap 時把使用者原始需求原封不動寫入)。所有 worker / reviewer 委派都帶這個路徑,避免靠 session 記憶或主 agent 轉述續跑。

跑指令前先把 `$SKILL_DIR` 換成 harness 給你的實際絕對路徑(帶引號,路徑可能含空白)。

## CLI 介面

```
node "$SKILL_DIR/scripts/cli.js" next     $MANIFEST                       # 印出下一個 action(單一,sync 用),並發派授權
node "$SKILL_DIR/scripts/cli.js" next-all $MANIFEST                       # 印出這一輪所有可平行 action(批次,async 用),並發派授權
node "$SKILL_DIR/scripts/cli.js" produce  $MANIFEST <specId> <result.json> # 記錄一個 spec 產出結果
node "$SKILL_DIR/scripts/cli.js" test     $MANIFEST <testId>  <result.json> # 記錄一次 test 結果
node "$SKILL_DIR/scripts/cli.js" resume   $MANIFEST <specId 或 testId> <answer.json> # 把使用者對 clarify 的答覆寫回,解除 blocked、續跑
node "$SKILL_DIR/scripts/cli.js" validate $MANIFEST                       # bootstrap 後結構自檢:參照完整 + 依賴無環;回 {ok:true} 或 {ok:false,errors:[…]}(exit 1)
```

`next`(單一)會印出以下其中一種 action:

| action | 意思 | 你要做的事 |
|---|---|---|
| `{"type":"produce","spec":"spec-2"}` | 該產出/重做這個 spec | 派它的 worker(`spec.skill` 是角色),依 review map 完成 produce 前審查或合法 defer,然後 `cli.js produce` |
| `{"type":"test","test":"test-x","spec":"spec-2"}` | 該驗這個 test | 依 `test.runner` 委派對應測試 worker(先備妥 runtime,見派工),然後 `cli.js test` |
| `{"type":"clarify","spec"\|"test":"…","question":"…","kind":"requirement\|environment\|oscillation\|review"}` | 需要使用者介入,不可自動推進。`kind:"environment"` 帶 `test`(掛在跑不起來的 test);其餘帶 `spec`。`kind:"review"` 不是失敗,是人類 gate(見處理步驟 review 段) | 停下把 `question` 問使用者;拿到答覆後寫 `answer.json` → `cli.js resume $MANIFEST <回傳的 spec 或 test> answer.json`,再回主迴圈 |
| `{"type":"done"}` | 全部 verified | 停止,把 `done` 回交呼叫端;若是由 `task-flow` 呼叫,後續 commit / teardown 由 `task-flow` 接手 |
| `{"type":"halt","reason":"…"}` | 撞到安全護欄(maxTurns) | 停止,把 reason 原樣回報,不要硬幹 |

`next-all`(批次)會印出:

| action | 意思 | 你要做的事 |
|---|---|---|
| `{"type":"batch","env":{…},"actions":[…]}` | 這一輪可同時跑的一批 produce/test(彼此無依賴邊);`env` 附在頂層,各 action 共用 | 同一回合把整批各自委派給一個子代理平行跑,全部回來後逐一記回 |
| `{"type":"clarify",…}` | 有 spec blocked(或 environment 的 manifest 層級 block)需釐清(全域停,`actions:[]`) | 同 `next` 的 clarify |
| `{"type":"done"}` / `{"type":"halt",…}` | 同上 | 同上 |

> `batch.actions` 為空不會發生:有 runnable 才回 `batch`。`actions` 第一個 === `next` 的回傳,所以同步退化時兩條路一致。

`next` / `next-all` 回傳的 `produce` / `test` action 都附一個 `brief` 欄位:引擎從 manifest 機械算出的派工輸入(`skill` 角色、上游 `depends_on_outputs`、`gate_outputs`(intake 文件路徑)、`last_failure` / `fix_target`、ownership 約束、`review.required_depth`;`env` 在單一 `next` 附在 brief、批次附在 batch 頂層)。委派時機械輸入以 `brief` 為準,不要自己讀 manifest 重新組裝;語意(需求原文、任務描述)仍讀 `orchestrator/requirement.md` 與 intake 文件。記回輸出內嵌的 `next` 不帶 `env`(同輪發派已給過)。

## 處理步驟(主迴圈)

工作用 manifest 固定為 `$MANIFEST`(= `orchestrator/manifest.json`,寫在使用者專案工作目錄下)。

1. **準備 manifest**:
   - 若 `$MANIFEST` 已存在 → 直接沿用,不重建,不重新規劃(這就是「接續跑到一半的流程」)。進主迴圈前若同目錄缺 `orchestrator/requirement.md`,停下請使用者補原始需求;不要用 session 記憶或 intake 轉述假裝原文。煙霧測試 / 試跑用的範本 manifest 不適用此檢查。
   - 若不存在,且只是要煙霧測試 / 試跑 → 把範本複製成工作檔(`mkdir -p orchestrator && cp "$SKILL_DIR/references/manifest.example.json" "$MANIFEST"`),不需要建立 `requirement.md`。
   - 若不存在,且使用者給的是真實需求 → 先把使用者原始需求原封不動寫成 `orchestrator/requirement.md`,再讀 `$SKILL_DIR/references/manifest-authoring.md` 照「intake:動態規劃」執行:派 intake、寫 draft manifest、`validate`、記回 intake produce 觸發人類 gate,放行後凍結。不要為同一份 draft 再跑第二次 intake。
   - 一律對 `$MANIFEST` 操作,不要動到 example 檔。
2. **問這一輪能跑什麼**(依執行模型擇一):平行用 `cli.js next-all`(一批互相獨立的 action),序列用 `cli.js next`(單一)。解析印出的 JSON。
3. **派工**:
   - `produce` → 依 action 的 `brief` 派一個 worker 子代理。語意輸入:給 worker `orchestrator/requirement.md` 的路徑,並把 intake 任務清單裡**這個任務自己的段落**(含驗證地圖 / review map 中它那一列)直接貼進派工 prompt——不要叫 worker 自己去讀整份 intake 文件。若 spec 有 `tier:"high"` / `"low"`,依本 host 的對應選擇子代理模型 / 設定;沒有對應能力就忽略。若這是重做(`brief.last_failure` 非 `null`)→ 務必把 `last_failure` 與 `fix_target`(`code`=修實作 / `spec`=改規格語意)一起交給 worker,讓它針對性修而非盲目重跑。並要求 worker:過程產物(`.md` 摘要等)寫在 `orchestrator/` 底下,且回報簡短 handoff summary(改了哪些檔、如何驗、風險點)。worker 產出後依 `planning.review_map` 決定 produce 前 reviewer 深度(見「reviewer 迴圈」),收斂版或合法 defer 才記回。
   - `test` → 委派測試 worker 時,要求它先在目標 worktree 依 `runtime-preflight` skill 的規則準備依賴環境(偵測 lockfile、建立 / 修復 worktree 內可變投影、只共享安全 cache / store),再對 `verifies` 的那個 spec 的產物實跑 `test.runner` 指定的測試,並把 preflight 狀態納入 evidence。test worker 屬機械執行角色,無特別標記時視同 `tier:"low"` 派低配子代理。preflight 或測試環境失敗時,test worker 回 `{ "pass": false, "altitude": "environment", "reason": "...", "evidence": {...} }`,不可歸咎到 spec。
   - 平行時:把 `next-all` 這批 `actions` 的 produce/test 在同一回合一起委派、同時跑,等整批回來。
   - **收結果,序列記回**:每個子代理回報後,你依它回報末尾的 JSON 區塊覆核轉錄(見「結果檔格式」)寫成一個 `result.json`,逐一 `cli.js produce` / `cli.js test` 記回——一個一個寫,不要平行寫。
   - `clarify` → 停下把 `question` 問使用者(不可自動重跑、不可臆測答案)。拿到答覆後寫 `answer.json`(`{ "answer": "<使用者答覆>", "reopen": "pending" }`;要保留原失敗脈絡讓 worker 針對性重做時用 `"failed"`)→ `cli.js resume $MANIFEST <clarify 回的 spec 或 test> answer.json` → 回第 2 步。(`kind:"environment"` 回的是 `test`,resume 後只重跑該 test、不重做任何 spec;其餘回的是 `spec`。)
     - **`kind:"review"`(人類 gate)是 clarify 的特例,不是失敗**:該 spec 宣告了 `review_gate: true`(本引擎用在 intake),引擎在它產出成功後停下,等使用者查看再繼續。你要把 clarify 裡列的產出檔路徑與重點摘要——**尤其是驗證地圖與 review map**——給使用者,討論到他明確表態。同意續跑 → `answer.json` 寫 `{ "approve": true }` → `cli.js resume`(spec 不重做、直接進 produced/verified);要求修改 → 寫 `{ "answer": "<修改意見>" }` → `cli.js resume`(reopen 重做,意見成為修補指示),重做成功後引擎再次 gate,直到使用者同意。沒有使用者明確同意,`approve` 不合法,嚴禁自行寫 `{"approve":true}` 跳過人類 gate。
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
4. **依賴獨立不等於檔案獨立**:`next-all` 只保證 action 在 `depends_on` 上互不依賴;平行 worker/test 仍必須寫入不重疊輸出或只做唯讀操作。需要平行安全時,intake 用任務拆分與 `allowed_outputs` 約束檔案 ownership。同一 spec 的多個 test 因常共用 runner / 工作區,`decideAll` 已每輪每 spec 只取一個 test 序列化,你不必特別處理。

## reviewer 迴圈(依 review map 決定深度)

worker 產出不是無條件直接記回:worker 產出後,依 human gate 核准的 `planning.review_map` 選審查深度。`review_map` 未列的 spec(或整份缺失)一律預設 `full`。引擎對此無知(只認得 `cli.js produce` 記回的結果);reviewer 全程不碰 manifest / `result.json` / routing,只挑戰、不代改。

review depth:

- `full`:派一個獨立 reviewer 子代理,對著使用者原文、該任務描述、上游 outputs、worker 產出與實際 diff / 檔案逐項複查。`no-judge`、高風險、跨模組 / 權限 / 資料遷移 / 發佈、需求含糊、重做中的 spec 一律 full。
- `focused`:派 reviewer,但輸入採差異導向。reviewer 必讀使用者原文與任務描述,可用 worker handoff summary 作索引,但必須抽查實際 outputs / diff / 檔案;不得只依 summary 通過。
- `defer-until-signal`:produce 前暫不派 reviewer。只允許低風險、output ownership 清楚、`requires_test:true` 且有可靠 machine test 的 spec;若該 spec 沒有 test、是 `no-judge`、`last_failure` 非空、worker 回報 `ok:false`、或 outputs 越界,不得 defer,改走 `full` reviewer 後再決定 produce 結果。produce 記回後仍由 `cli.js test` 驅動 machine test;若 test fail / 無法跑 / evidence 不足,照 test 結果回寫失敗並重做,下一輪此 spec 視為升級訊號走 `full` reviewer。

worker handoff summary 只作導覽索引,不是事實來源。reviewer 的事實來源仍是使用者原文、任務描述、上游 outputs、實際產物 / diff 與測試證據。

**獨立性怎麼拉**(同一模型供應商下盡量降低錯誤相關性):

- **reviewer 同時接收 input 與 output**,且 input 包含 `orchestrator/requirement.md` 中**原封不動**的使用者原文,而非只給 intake 轉述的衍生規格。此舉使 reviewer 由「一致性檢查」升級為「忠實度檢查」。
- **以對抗式 framing 取得部分分布獨立**:worker 受命「完成任務」,reviewer 受命「假設此產出已上線並出問題,反推其失效方式」。
- **高槓桿節點(intake)採對抗式、明令『盡力挑漏』的 reviewer**,而非確認式 reviewer。
- **成本控制不取代現實接觸**:`defer-until-signal` 只能略過 produce 前 reviewer,不能取代 human gate 或後續 machine test。

**收斂後記回**:委派 reviewer 時就要求它把結論自己寫成 `orchestrator/review-<specId>.md` 落盤,回報只給「verdict + record 檔路徑 + 一句話重點」,不要把審查全文貼回來。reviewer 過了 → 記 `{ ok:true, outputs:[…], review:{ depth:"full"|"focused", record:"orchestrator/review-<specId>.md" } }`;合法 defer → `{ ok:true, outputs:[…], review:{ depth:"defer-until-signal" } }`;reviewer 審出做歪 → `{ ok:false, reason, fix_target:"code"|"spec" }` 或往前歸咎 `{ ok:false, blame:"spec-上游" }`,由引擎回頭重做。引擎在記回時硬驗 `review`:深度不得低於 review map 要求(未列預設 full;`last_failure` 非空的重做一律 full),full / focused 的 `record` 檔必須存在於磁碟,defer 必須有 `requires_test` + test 護欄。worker↔reviewer 最多 3 輪;3 輪仍未收斂視為這一站產不出來,照 produce 失敗記回讓引擎接手(會留下無進度訊號,反覆即觸發震盪 clarify 停下問人)。

> reviewer 不能取代人類 gate 或能機器驗節點的真 test;設計原理見 `docs/design-notes/generic-recursive-task-engine.md`。

## 結果檔格式(由 orchestrator 覆核轉錄 worker 的回報區塊,worker 不碰檔案)

`result.json` 一律由你寫,worker 本身不產。委派時就要在派工 prompt 末尾要求 worker:回報末尾附一個 ```json 區塊——produce 站用 `{ "ok": true|false, "outputs": […], "reason"?, "fix_target"?, "blame"? }`(`review` 欄位由你在審查收斂後補上,不是 worker 回報的),test 站用 `{ "pass": true|false, "altitude"?, "blame"?, "reason"?, "evidence", "env_patch"? }`(test 的 `evidence` 在 `pass:true` 時必填:unit 為 `{ command, exit_code, passed, failed, todo? }` 實跑計數,e2e 為行為證據)。你拿到後做覆核 + 機械轉錄:檢查 `blame` 指向 manifest 裡存在的 spec、`altitude` 是四向之一,然後照抄成 `result.json`——不要讀散文摘要自由創作。這一步是全系統唯一的 LLM 翻譯點,轉錄越機械越安全;worker 沒附區塊或欄位不合法,先向它要正確區塊,再記回。

`cli.js` 會在套用前對 `result.json` 與 `answer.json` 做 schema 驗證:欄位型別、`altitude` / `verdict` / `fix_target` / `reopen` 的 enum、`blame` 必須指向存在的 spec、失敗的 test 必須明帶 `altitude`(不預設 code);resume 則驗 `answer` 非空、`approve` 只在 review gate 合法且只接受 boolean `true`。驗不過 → exit 1、manifest 不動、回合不增;照錯誤訊息修正後重送一次,不算失敗一輪。

另有幾道誠實性守門,同樣 exit 1、manifest 不動:`produce` / `test` 只接受 `orchestration.leases` 裡發派過的 action;produce 成功記回必帶 `review` 欄位(深度合規、full / focused 的 `record` 檔存在,引擎記回後存進 `spec.last_review`);produce 的 `outputs` 逐一驗檔案真的存在於磁碟;test 的 `pass:true` 必須帶非空 `evidence`,且若 evidence 帶 `failed` / `passed` 計數則必須 `failed===0`、`passed>=1`(todo-only 零實質斷言不算通過);`kind:"unit"` 的 pass 還必須含 `{ command, exit_code:0, passed, failed }`;worker 回報「未能執行」時走 `altitude:"environment"`,不是 pass;`altitude:"environment"` 不可帶 `blame`;`env_patch` 只能寫 `env_patchable` 白名單裡的欄位;`requires_test` 宣告的 spec 若沒有任何 test verifies 它,produce 記回也會被擋。

`result.json` 與 worker 的 JSON 回報區塊都是引擎內部交換格式,不是給使用者的交付物——不要 surface 給使用者、也不要當「成果」保存;交付與查看(含人類 gate)給使用者的一律是各 worker 的 `.md` 產出。

> **`result.json` 是一次性參數,用完即丟。** 它唯一的作用是把 worker 這一輪的結果搬進 manifest;搬完就沒用了,`decide.js` 從頭到尾只讀 manifest。用單一 scratch 路徑每回合覆寫(例如 `/tmp/wf-result.json`)即可,不要 per-spec / per-test 留一堆。`produce` 成功記回必帶 `review` 欄位;`review_gate` spec 與任何下游需要讀 outputs 的 spec 必須明確記 outputs;`test` 的必填。

produce 結果(三種):

```json
{ "ok": true, "outputs": ["orchestrator/intake-analysis.md"], "review": { "depth": "full", "record": "orchestrator/review-spec-1.md" } }
```

- 這個 spec 自己產不出來、要重做它:`{ "ok": false, "reason": "...", "fix_target": "code" }`(或 `"spec"`)
- 根因在更前面的 spec(往前修):`{ "ok": false, "reason": "spec-1 的任務拆解漏了 X", "blame": "spec-1" }` → `cli.js` 把 `spec-1` 標 failed、把依賴它的下游退回重驗,自己退回 pending 等上游修好。(`blame` 指向 intake spec 即「退回重 intake」,intake 重做後人類 gate 再次觸發。)

test 結果(兩個正交軸 `altitude` + `blame`):

```json
{ "pass": false, "blame": "spec-2", "altitude": "spec", "reason": "產出與需求不符,根因在規格", "evidence": { "expected": "...", "actual": "...", "snapshot": "..." } }
```

- `altitude`(性質,四向):`code`=實作做歪(重做該 spec、不 cascade)/ `spec`=規格錯(重做+cascade)/ `requirement`=需求欠明確(該 spec 標 `blocked`)/ `environment`=基礎設施錯(app/依賴起不來等,不歸咎任何 spec,改標 manifest 層級 `m.block`、掛在該 test)。後兩者 `next` 都會回 `clarify` 停下問人。
- 選 `altitude` 的判斷:程式忠實照規格卻仍錯 → `spec`(或更上游,用 `blame` 指);規格對、實作沒照做 → `code`;需求自己沒定義清楚 → `requirement`;環境問題 → `environment`。
- `blame`(定位,選填):根因在哪個 spec-id。省略時預設 = 該 test 的 `verifies`;指定時可直接退到任一上游站(一跳,不必接力)。
- `reason` 一律 string;結構化細節放 `evidence`(object)。
- `env_patch`(選填,object):worker 偵測到的執行期事實,cli 會經它寫進 `manifest.env`(只接受 `env_patchable` 白名單裡的欄位)。
- 向後相容:舊 `{ "pass": false, "verdict": "spec"|"code" }` 仍可用(自動映射成同名 `altitude`、`blame` 預設 `verifies`)。

通過時:`{ "pass": true }`(附 `evidence`)。

## 失敗判斷:下對歸咎

「回頭」不是只有 test 掛掉才會,produce 階段(worker/reviewer 判定產不出對的結果)同樣會回頭。兩階段共用一個原則:**把失敗歸咎到「真正該改的那個 spec」,而不是當下這一步。** `altitude` / `blame` 的語意與路由後果見上「結果檔格式」。

**produce 掛掉**,三種:

- 問題就在這一步 → `{ "ok": false, "fix_target": "code"|"spec", "reason": "..." }`,重做這個 spec。
- 問題其實在更前面的 spec(reviewer 判定根因在上游)→ `{ "ok": false, "blame": "spec-1", "reason": "..." }`,`cli.js` 往前把 `spec-1` 標 failed、串級退回下游。`blame` 指 intake spec 即退回重 intake。
- 基礎設施錯誤(環境壞、依賴裝不起來、網路斷、worker crash)→ 這不是內容問題,不要寫 `ok:false` 去觸發回頭重做(重做也沒用,只會空轉撞 maxTurns)。重試幾次仍不行就停下找使用者。

> produce 與 test 的失敗都會留下「無進度訊號」(target-first 的 `{spec}:{altitude}`)。同一個 `{target,altitude}` 在一段未解決 episode 內累計 `noProgressK` 次(預設 3;per-target,某 target 一有進度只清它自己的訊號),`cli.js next` 會回 `clarify`(震盪→停下問人,也能抓到修 A 壞 B 的交替震盪)。

## 安全與終止(已內建在 cli.js)

- **最大回合數**:`manifest.orchestration.maxTurns`(預設 30)。超過 → `halt`(放棄,停手回報 reason)。
- **無進度偵測**:同一個 `{target,altitude}` 累計 `noProgressK` 次(預設 3)→ 判定震盪 → `clarify`(停下問人,可續),不是 `halt`。
- **clarify**(需求歧義 / 環境問題 / 震盪 / 人類 gate):停下問使用者 → `cli.js resume` → 續跑,是暫停不是終局。
- **能機器驗的任務必實跑**:不以 reviewer 的「看起來對」取代可取得的 `exit_code` 或行為證據;無客觀裁判的節點誠實標記為「無裁判」。
- **對外 / 不可輕易還原的動作一律維持人工**:任何 `git push`、開 PR、deploy、刪檔、花錢的 API 都不在自動範圍,需要時請求使用者確認。

## 交付前自檢

只檢查鐵則未覆蓋、實務上最常做歪的幾件事:

- 重做 `failed` spec 時已把 `last_failure` 與 `fix_target` 當修補指示交給 worker,沒讓它盲目重跑
- 每份 `result.json` 都從 worker 回報的 JSON 區塊覆核轉錄而來(blame 存在、altitude 合法、pass 附實跑 evidence),沒有自由創作,也沒替沒附證據的 pass 補造 evidence
- 收到 `clarify` 時已把 `question` 原樣問使用者、未臆測答案;`kind:"review"` 時已把分析書 / 任務清單 / **驗證地圖 / review map** 交給使用者討論到明確表態,`{"approve":true}` 只在使用者同意後才寫
- 委派 `test` 時已要求 test worker 先依 `runtime-preflight` 準備環境;能機器驗的節點都實跑
- 全程只在 `clarify` / `done` / `halt` 三種停點結束過回合;`done` 後未自行 commit / teardown(交回 `task-flow`)
