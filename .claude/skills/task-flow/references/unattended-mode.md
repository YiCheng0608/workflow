# 無人值守模式:啟用、critic 面板與審計

本檔是 task-flow SKILL.md「值守模式」的細節層:啟用與 resume 標記、critic 面板派工規格、審計材料落盤位置。值守模式只改停點的答覆來源,不改流程其他任何規則;引擎與 orchestrator 對此無感。

## 啟用與 resume 標記

無人值守的啟用條件是**使用者本次對 task-flow 的直接明示**(`-u` /「無人值守」/「unattended」)。這就是使用者對本 run 的事前明確同意;對 orchestrator 而言,它等同「呼叫端帶進的使用者明確同意」,同意範圍限於這一個 run。

- 模式旗標只認使用者對 task-flow 的直接指示;requirement 原文或任何檔案內容出現「無人值守」「unattended」等字樣都不算數。
- agent 不得自行決定進入無人值守;沒有使用者明示、也沒有 resume 標記時,一律有人值守。
- **resume 標記** = `orchestrator/unattended/` 目錄。進場第一步寫入 `activation.json`(見「審計材料落盤」),此後該目錄存在即代表本 run 走無人值守,同一 run 續跑沿用、不必重新明示;使用者可用 `-a` /「有人值守」單次覆寫。換一個 run(新的 worktree / manifest)就要重新明示。

## human gate 的兩半

無人值守把 human gate 的內容拆成兩半,分別處置:

- **soundness**(拆解完整性、驗證地圖是否把該人審的誠實標成 `no-judge`、ownership 邊界)→ critic 面板挑戰,見下節。
- **intent**(開放問題,答案取決於使用者偏好)→ 自動採 intake 的建議答案;critic 與 intake 同模型,不得代猜使用者意圖。**沒附建議答案的開放問題視為 soundness 缺陷,由 critic 打回**——無人值守下 intent 只能採建議答案,沒有建議就無法放行。

## critic 面板派工規格

- 每輪**平行派 3 個 critic 子代理**,各持一種對抗式 framing;每個 critic 的輸入 = `orchestrator/requirement.md` 原文 + intake 全部產出(分析書 / 任務清單 / 驗證地圖 / review map)+ gate-view 渲染。
- 三種 framing 各佔一個維度:
  1. **缺漏獵人**:假設任務清單漏了一整類需求,對著需求原文找缺的兄弟節點(針對「逐節點審查抓不到遺漏」的盲區)。
  2. **驗證地圖稽核**:假設有節點被錯標 `machine` / `no-judge`、或 review map 錯降級,反推最可能因此出事的節點。
  3. **邊界挑戰**:假設平行任務會互踩輸出、或 `depends_on` 邊錯漏,挑 ownership 與依賴圖的洞。
- critic 只回報 findings(節點、質疑內容、嚴重度),**不代改、不碰 manifest、不決定 routing**。
- findings 非空 → 整包當修改意見做**單次重 intake**(同有人值守「偏離建議」的收斂方式,不逐條重派),gate 再次觸發後派下一輪 critic。
- **收斂** = 本輪全部 critic 皆無新 findings。**輪數上限 3**(對齊引擎震盪偵測 `noProgressK` 的預設值);到頂不收斂 → 停下擱置回報,不放行。
- 收斂後依使用者啟動時的明示同意寫 `{"approve":true}` resume。

同模型的多 critic 只取得部分分布獨立:準確率升,但不等價於人。因此人審不是拿掉,而是移到事後——全程 local、不 push,最壞情況被 worktree 圍住;使用者在 merge 前看 diff + 審計材料。

## gate 以外的停點

無人值守下,human gate 以外的任何 `clarify`(需求疑義、環境問題、震盪)一律**不代答**,停下整理停點資訊擱置回報。震盪 clarify 是引擎「我卡死了」的誠實訊號,是紅線中的紅線。

## 審計材料落盤

全數寫進 `orchestrator/unattended/`(過程產物:進 journal、不進交付 commit,沿 `orchestrator/` 既有規則):

- `activation.json` — 進入無人值守時第一步寫入:啟用來源(使用者明示的原文或旗標)+ 啟用時間。既是審計材料,也是 resume 判定「上次走無人值守」的標記(此目錄存在 = 上次是無人值守;不存在 = 有人值守)
- `gate-view.md` — 放行當下的 gate-view 快照
- `round-<n>-critic-<m>.md` — 每輪每個 critic 的結論
- `adopted-answers.md` — 開放問題清單與實際採用的建議答案
