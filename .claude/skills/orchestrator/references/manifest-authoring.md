# manifest 撰寫與受控修補

只在三種情境讀這份:(a) bootstrap 第一次建立 draft manifest;(b) 引擎退回重 intake 後要修補 manifest 結構;(c) 使用者明確要求補做某個機器驗收。主迴圈的日常推進不需要它。

## manifest 的欄位邊界

bootstrap / intake 只寫引擎會讀的通用欄位與本節明列的 orchestrator 策略欄位:spec 的 `id` / `skill` / `status` / `depends_on` / `outputs` / `last_failure` / `fix_target`,可選的 `review_gate` / `forbid_outputs` / `allowed_outputs` / `requires_test` / `tier`;test 的 `id` / `verifies` / `runner` / `kind` / `status` / `depends_on` / `last_fail`;以及 `env`、`env_patchable`、`planning`、`orchestration`。`planning` 可包含 `verification_map`、`review_map`;`tier` 與 `planning` 內的策略資料只給人類 gate / orchestrator 派工使用,`decide.js` 不讀。`block_kind` / `clarify` / `clarifications` / `last_review` / `orchestration.leases` / test `evidence` 等執行期欄位由 `cli.js` 寫,bootstrap / intake 不預填。

`tier` 是選填、廠商中立的難度 / 槓桿提示,只接受 `"high"` / `"medium"` / `"low"`;省略 = 交給 host 預設,`"medium"` = 明確要中檔(不隨 host 預設漂移);不確定就省略。實際 tier → 模型 / 子代理設定的對應是 host-local 決定,不寫進 manifest;不要在 manifest 寫具體模型名或廠商。

語意(需求原文、任務在講什麼、為什麼這樣拆、每個任務的驗收細節)住在 `orchestrator/requirement.md` 與 **intake 產出的分析書 / 任務清單 / 驗證地圖 / review map(.md)**,不寫成 manifest 新欄位。**不要為了帶語意新增 manifest schema**:manifest 不增加 `inputs` / `bindings` / `phase` 等欄位。委派 worker 時,主 agent 讀 requirement 與 intake 的產出,把對應的任務描述、上游 `outputs` 檔案與 `env` 事實交給子代理。

## intake:動態規劃(bootstrap)

整條流程唯一的動態步驟:派一個 **intake 子代理**解析需求、拆成任務清單、為每個任務指定驗證方式與審查深度。你據此寫出 draft manifest,再把 intake 產出的分析書 / 任務清單 / 驗證地圖 / review map 作為 intake spec 的 outputs 記回,由 `review_gate:true` 停下給使用者審。人類 gate 放行後,這一版 manifest 才凍結並開始跑下游。

**你要做的**:

1. **派 intake 子代理**產出分析書 + 任務清單 + **驗證地圖** + **review map**(下游 worker 任務逐一列驗證方式、風險、拆分理由、review depth 與升級條件)。intake 是全流程唯一的動態步驟、槓桿最高,派工一律視同 `tier:"high"`(依本 host 的對應選高階子代理模型;沒有對應能力就忽略)。intake 產出先過一輪「盡力挑漏」的對抗式 reviewer;reviewer 自己把結論寫成 `orchestrator/review-<intake spec id>.md`(記回時作 `review.record`);這一輪不靠 review map。
2. 依 intake 的任務清單,決定這次要哪些 spec(各自 `skill` 角色、`depends_on`)、配哪些 test(`verifies` 指向哪個 spec)。能機器驗的任務掛真 test(`kind:'unit'`/`'e2e'`、指定 `runner`);無客觀裁判的任務不掛 test,誠實標記。這一步只做一次 draft manifest,不要等主迴圈又重跑同一份 intake。
3. 依 `manifest.example.json` 的結構寫出 `$MANIFEST`:
   - 每個 spec 帶 `id` / `skill` / `status:"pending"` / `depends_on` / `outputs:[]` / `last_failure:null` / `fix_target:null`;每個 test 帶 `id` / `verifies` / `runner` / `kind` / `status:"pending"` / `last_fail:null`。
   - `intake` spec 帶 `review_gate:true`(= 人類 gate,設在 intake 產出之後)與 `tier:"high"`(重 intake 的重派沿用同一提示);其餘 spec 不帶 `review_gate`。
   - `orchestration` 寫 `{ turn:0, maxTurns:<按規模>, noProgressK:3, failSignals:[] }`。`maxTurns` 按規模設:`max(30, 3 × (spec 數 + test 數))`。
   - 選填欄位依需求填,沒需要就不填:
     - `forbid_outputs`(glob 陣列):宣告「這個 spec 不得產生的檔」;produce 記回時 outputs 命中任一樣式 → 引擎改判 `code` 失敗回頭重做。worker 寫成品不寫測試,故禁 `*.test.*` / `*.spec.*` / `*__tests__*`。
     - `allowed_outputs`(glob 陣列):宣告「這個 spec 只能產生的檔」;outputs 有任一檔未命中白名單 → 改判 `code` 失敗回頭重做。用來把彼此平行的節點鎖進不重疊的檔案 ownership。
     - `requires_test`(boolean):宣告「此 spec 必須有 test 驗證」;`validate` 與 produce 記回都會擋「宣告了卻沒掛 test」(驗證地圖標 machine 的節點一律填)。
     - `tier`(`"high"` / `"medium"` / `"low"`):選填的 orchestrator 派工提示;引擎不讀,不影響 routing。不需要或不確定時省略。
     - `env_patchable`(string 陣列):worker 經 `env_patch` 可回寫的 env 欄位白名單,防 worker 改寫身份 / 前提欄位。
   - `env` 依需求填(這次任務需要哪些執行期事實 / 設定就寫哪些);沒需要的欄位不臆造。
   - **寫出後、凍結前先跑 `cli.js validate $MANIFEST`**(`depends_on` / `verifies` / test `depends_on` 都指向存在的節點、依賴無環;`tier` 與 `review_map.review_depth` enum 合法;`review_map.task` 指向存在 spec;`review_map` 標 `defer-until-signal` 的 spec 必須 `requires_test:true` 且有 test verifies 它);回 `{ok:false,errors}` 就先修好再凍結——別把懸空參照、成環或無機器護欄的 defer manifest 丟進主迴圈,引擎不報錯,只會讓相關節點永遠不 ready 或靜默缺少現實接觸,難診斷。
4. **記錄驗證地圖與 review map**:`manifest.planning.verification_map` 逐任務寫 `{ task, verdict:"machine"|"no-judge", how, reason }`;`manifest.planning.review_map` 逐任務寫 `{ task, risk, review_depth, split_reason, upgrade_triggers, reason }`。這些欄位純策略與人類可讀資料,不參與 `decide.js` 控制流。形狀見 `manifest.example.json` 的 `planning` 區塊。
5. **記回 intake 產出以觸發人類 gate**:先跑 `cli.js next $MANIFEST` 讓引擎發派 intake 的 produce(沒發派過的記回會被擋),再寫一份 result.json,至少包含 `{ "ok": true, "outputs": ["orchestrator/intake-analysis.md", ...], "review": { "depth": "full", "record": "orchestrator/review-<intake spec id>.md" } }`(`record` = 第 1 步對抗式 reviewer 的結論檔,必須真的落盤),再跑 `cli.js produce $MANIFEST <intake spec id> result.json`。intake / `review_gate` spec 不可省略 outputs,因為 gate 必須把分析書、任務清單、驗證地圖與 review map 交給使用者看。
6. **人類 gate**:`review_gate:true` 的 intake spec 在產出後會被引擎標 `blocked(kind:'review')`,主迴圈收到 `kind:"review"` 的 clarify 時停下。把分析書、任務清單、**特別是驗證地圖與 review map**呈現給使用者——人確認的不只是「要做這些任務」,而是「**接受其中哪些任務沒有客觀裁判、哪些任務先延後 reviewer、哪些訊號會自動升級**」。同意 → resume `{approve:true}` 放行下游;要修改 → resume 帶意見重做 intake、再次 gate。

過人類 gate 後 → 這一版 manifest 凍結 → 回到主迴圈第 2 步。

人類 gate 的設計原理見 `docs/design-notes/generic-recursive-task-engine.md`;操作上,若需求形狀問不出、或缺關鍵驗收前提,先停下處理,不要寫一份排除關鍵裁判的 manifest 硬跑。

## 重 intake 的結構修補

若 reviewer / test 把 `blame` 指回 intake spec,引擎會退回重 intake,且重做成功後必須再次人類 gate。重 intake 可能只修分析書 / 任務描述,也可能改變任務圖:

- 任務圖不變 → 不手改 manifest 結構;重跑 intake spec、記回新的 outputs,讓 `review_gate` 再次停下。
- 任務圖、驗證地圖或 review map 改變 → 在記回新版 intake produce 前,只更新 `specs` / `tests` / `planning` / `env` / 約束欄位;新增節點用 `pending` 初始化,不要手動推進任何既有節點狀態。改完先跑 `cli.js validate $MANIFEST`,再記回 intake produce 觸發 gate。
- 若新版計畫需要移除已產出 / 已驗證的下游節點,不要靜默刪除;在 gate 呈現「將捨棄哪些既有節點與產出」,等使用者明確同意後才保留新版 manifest。

## 補做機器驗收(凍結後的受控修補,別繞過引擎)

manifest 凍結後不可重新規劃,但使用者明確要求「現在補做某個機器驗收」是合法的受控修補:補一個 test 結構節點再交給引擎跑(這是除 bootstrap 外唯一被授權碰 manifest 結構的情形,補完即凍結)。核心鐵則不變:**補的 pending test 由引擎自動排出來驗,狀態只經 `cli.js test` 記回;絕不可為了省事直接呼叫測試 worker、跳過 `cli.js test`**(那會繞過 `environment` 失敗該觸發的 `m.block`→`clarify`)。

補 test 節點:`{ id, verifies:<要驗的 spec>, runner, kind, status:"pending", last_fail:null }`(要排在其他 test 之後就加 `depends_on`),並在 `planning.verification_map` 把該任務從 `no-judge` 改記為 `machine`。寫好後不動任何 `status`,回主迴圈讓引擎排出來驗。
