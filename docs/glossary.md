# 名詞解釋

本檔收斂 repo 內常用術語。文件與 skill 內優先保留英文 canonical term;第一次需要說明時,可用括號補繁中。

## 流程與狀態

- `task-flow`:完整入口流程。負責 preflight triage、worktree / commit / teardown 策略,並呼叫 `orchestrator` 跑 manifest。
- `orchestrator`:引擎編排器。只讀 manifest、呼叫 `cli.js` 取得下一步、委派 worker / reviewer、把結果寫回 manifest。
- `manifest`:磁碟上的唯一事實來源。任務圖、狀態、驗證與審查策略都以它為準。
- `worktree`:隔離的 git 工作目錄。讓一個 run 的修改、過程產物與 commit 收尾不污染主 checkout。
- `journal`:過程紀錄的持久位置。`orchestrator/`、`unattended mode` 審計材料等不進交付 commit,但可寫進 journal 供追溯。

## 角色

- `intake`:動態規劃角色。把使用者需求拆成任務清單、驗證地圖與 review map,並產出 human gate 可審的文件。
- `worker`:執行單一任務節點的角色。不得私自再拆任務;需要重拆只能退回重 `intake`。
- `reviewer`:對著需求原文與 worker 產出挑錯的角色。不代改、不碰 manifest、不決定 routing。
- `critic`:`unattended mode` 在 human gate 使用的對抗式審查角色。只挑 soundness findings,不代改 manifest。

## Gate 與模式

- `human gate`:intake 產出後的審查點。它是流程節點,不是一種執行模式。審查重點是任務覆蓋、驗證地圖、review map、`no-judge` 與 reviewer 降級是否可接受。
- `supervised mode`（有人值守）:預設值守模式。`clarify` 與 human gate 都同步轉問使用者;gate 的開放問題逐題訪談。
- `unattended mode`（無人值守）:只能由使用者本次對 `task-flow` 直接明示,或同一 run 的 `orchestrator/unattended/` resume 標記沿用。human gate 的 soundness 一般由三 critic 代審；只有嚴格低風險 compact flow 可先用整合 critic。intent 採 intake 建議答案；其他 `clarify` / `halt` 仍停下。

## 停點

- `clarify`:可恢復的暫停點。代表需求歧義、環境問題、震盪或 human gate 需要外部答覆;resume 後可續跑。
- `done`:manifest 任務圖全數 verified。對 `orchestrator` 是終點;對 `task-flow` 還要接 commit / teardown 收尾策略。
- `halt`:安全護欄停機,例如 maxTurns。不是要 agent 硬猜答案的停點。

## 驗證與審查

- `verification map`:intake 產出的驗證地圖。標示每個任務由 machine test 或 `no-judge` 驗收。
- `review map`:intake 產出的審查策略。決定每個 worker 產出後走 `full`、`focused` 或 `defer-until-signal` reviewer。
- `no-judge`:沒有客觀機器裁判的節點。必須在 human gate 中明確揭露並接受。含 UI 畫面的交付以渲染結果為裁判,不適用 `no-judge`。
- `defer-until-signal`:低風險且有可靠 machine test 護欄時,produce 前暫不派 reviewer;一旦出現失敗或越界訊號即升級。
- `ui-smoke`:UI 交付的機器驗收 test(`kind:"e2e"`):起 dev server、開目標頁面、對 `intake-ui-checklist.md` 逐項核對;pass evidence 為截圖與逐項核對結果。

## 拆分與脈絡

- `tag`:intake 給任務的選填分組標記(短 kebab-case,如 `api-crud`)。同一套慣例 / 範本適用的任務共用 tag;只住在 intake 文件,不進 manifest 欄位。
- `notes`:`orchestrator/notes/<tag>.md`。orchestrator 從 worker handoff summary 蒸餾的跨站導覽索引,固定三節 Guideline / Prototype / Pitfalls;是索引,不是事實來源。
- `prototype-first`:同質群組跨多個 spec 時的拆法。第一個 spec 只做一個代表項當範本走 `full` review,其餘項目放複製批 spec、`depends_on` 範本,照範本與 notes 複製。
- `scout`:orchestrator 派 intake 前選用的唯讀探索子代理。按需求涉及的獨立探索面向 0~4 個平行派,彙整成 `orchestrator/intake-context.md`;是索引,不是事實來源,規劃決策仍由單一 intake 做。
- 輕量流程:preflight triage 的中間檔。照完整流程跑,但以輕量偏好要求 intake 粗粒度拆分,並以單一整合終驗收斂。
