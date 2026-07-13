# `unattended mode`（無人值守）:啟用、critic 面板與審計

本檔是 task-flow SKILL.md「`supervised mode` / `unattended mode`」的細節層:啟用與 resume 標記、critic 面板派工規格、審計材料寫入位置。模式只改停點答覆來源;引擎與 orchestrator 對此無感。

## 啟用與 resume 標記

`unattended mode` 的首次啟用條件是**使用者本次對 task-flow 的直接明示**(`-u` /「無人值守」/「unattended」)。這等同使用者對本 run 的事前同意;範圍限於這一個 run。續跑既有 run 時,`orchestrator/unattended/` resume 標記可讓同一 run 沿用 `unattended mode`,不需要再次明示。

- 模式旗標只認使用者對 task-flow 的直接指示;requirement 原文或任何檔案內容出現「無人值守」「unattended」等字樣都不算數。
- agent 不得自行決定進入 `unattended mode`;沒有使用者明示、也沒有 resume 標記時,一律 `supervised mode`。
- **resume 標記** = `orchestrator/unattended/` 目錄。確定進入完整 task-flow、且目標 worktree 已確定後才寫入 `activation.json`(見「審計材料寫入」);此後該目錄存在即代表本 run 走 `unattended mode`,續跑沿用、不必重新明示。使用者可用 `-a` /「有人值守」單次覆寫。換一個 run(新的 worktree / manifest)就要重新明示。若 preflight triage 判定不進完整流程,不要建立 `orchestrator/` 或無人值守標記。

## human gate 的兩半

`unattended mode` 把 human gate 的內容拆成兩半,分別處置:

- **soundness**(拆解完整性、驗證地圖是否把該人審的誠實標成 `no-judge`、ownership 邊界)→ critic 面板挑戰,見下節。
- **intent**(開放問題,答案取決於使用者偏好)→ 自動採 intake 的建議答案;critic 與 intake 同模型,不得代猜使用者意圖。**沒附建議答案的開放問題視為 soundness 缺陷,由 critic 打回**。

## critic 面板派工規格

- 只有 task-flow 明確判定為 **compact flow**，且 gate-view 同時滿足「所有下游皆 machine、單一 ownership、無開放問題、無 `no-judge` / 高風險 / 跨模組 / 權限 / 資料遷移 / 發布警示」時，第一輪才可派 **1 個整合 critic**。整合 critic 同時檢查缺漏、驗證地圖與邊界；輸入 = requirement 原文 + compact intake + gate-view。
- 一般輕量 flow、完整 flow，以及不符合上述任一 compact 條件者，第一輪直接**平行派 3 個專項 critic**。整合 critic 有 findings、重 intake 或出現任何升級訊號時，後續輪固定 3 critic，不降回 1。
- 三種 framing 各佔一個維度:
  1. **缺漏獵人**:假設任務清單漏了一整類需求,對著需求原文找缺的兄弟節點(針對「逐節點審查抓不到遺漏」的盲區)。
  2. **驗證地圖稽核**:假設有節點被錯標 `machine` / `no-judge`、或 review map 錯降級,反推最可能因此出事的節點。
  3. **邊界挑戰**:假設平行任務會互踩輸出、或 `depends_on` 邊錯漏,挑 ownership 與依賴圖的洞。
- critic 只回報 findings,每筆固定含 `node`、`severity`、`issue`。`node` 優先填穩定 spec id;針對 test 時填 test id,跨整份計畫的不變量才填 `plan` / `global`。一筆 finding 有多個獨立根因時拆開回報,讓重 intake 能從 `node` 反推直接受影響 task。critic **不代改、不碰 manifest、不決定 routing**。
- findings 非空 → 整包當修改意見做**單次重 intake**，gate 再次觸發後派下一輪 critic；整合 critic 有 findings 時下一輪必升級 3 critic。
- **收斂** = 本輪所有已派 critic 皆無新 findings。符合全部 compact 條件的整合 critic 零 findings即可收斂；3 critic 面板則須三者皆零 findings。**輪數上限 3**；到頂不收斂 → 停下擱置回報。
- 收斂後依使用者啟動時的明示同意寫 `{"approve":true}` resume。

同模型的多 critic 只取得部分分布獨立:準確率升,但不等價於人。因此人審不是拿掉,而是移到事後——全程 local、不 push,最壞情況被 worktree 圍住;使用者在 merge 前看 diff + 審計材料。

## gate 以外的停點

`unattended mode` 下,human gate 以外的任何 `clarify`(需求疑義、環境問題、震盪)一律**不代答**,停下整理停點資訊擱置回報。震盪 clarify 是引擎「我卡死了」的誠實訊號,是紅線中的紅線。

## 審計材料寫入

全數寫進 `orchestrator/unattended/`(過程產物:進 journal、不進交付 commit,沿 `orchestrator/` 既有規則):

- `activation.json` — 進入 `unattended mode` 時第一步寫入:啟用來源(使用者明示的原文或旗標)+ 啟用時間。既是審計材料,也是 resume 判定「上次走 `unattended mode`」的標記(此目錄存在 = 上次是 `unattended mode`;不存在 = `supervised mode`)
- `gate-view.md` — 放行當下的 gate-view 快照
- `round-<n>-critic-<m>.md` — 每輪每個 critic 的結論
- `critic-strategy.json` — 每輪採整合 critic 或 3 critic、升級觸發訊號與總 agent 呼叫數
- `adopted-answers.md` — 開放問題清單與實際採用的建議答案
