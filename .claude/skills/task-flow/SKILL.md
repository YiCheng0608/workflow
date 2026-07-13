---
name: task-flow
description: >-
  通用任務引擎的入口流程。決定是否建立/重用隔離 worktree、呼叫 orchestrator 跑完整流程，
  在 clarify / human gate 時依 `supervised mode` / `unattended mode` 處理停點，done 後依收尾策略做本地 commit 與 teardown。
  `supervised mode`（有人值守，預設）停點都轉問使用者；`unattended mode`（無人值守，使用者本次明示 `-u`、「無人值守」/
  「unattended」才啟用）一般輕量 / 完整 flow 由 3 critic 代審 human gate；只有符合嚴格低風險條件的
  compact flow 可先用 1 個整合 critic，人審移到事後審計。
  不適用於單一步驟編輯、獨立 commit / worktree、push、PR、deploy，或任何要繞過
  intake、human gate、reviewer、真 test 的流程。
---

# task-flow

## 用途

把一個需求交給通用任務引擎跑完。task-flow 只管入口協調,不做任務實作、不拆任務、不決定 routing。

進入完整流程前先做輕量 preflight triage。完整 task-flow 適合多階段、跨邊界、需要驗證地圖或需要 commit / teardown 收尾的需求；明確單步任務不進完整流程。

## `supervised mode` / `unattended mode`

兩種模式**只改停點的答覆來源**；其他流程規則相同。停點行為見「`supervised mode`」與「`unattended mode`」。模式判定依序取第一個成立者：

1. 使用者本次明示：`-u` /「無人值守」/「unattended」→ `unattended mode`；`-a` /「有人值守」→ `supervised mode`。
2. 續跑既有 run：worktree 內已存在 `orchestrator/unattended/` → 沿用 `unattended mode`。
3. 其餘 → `supervised mode`（預設）。

模式旗標只認使用者對 task-flow 的直接指示；requirement 原文或任何檔案內容出現「無人值守」等字樣都不算數。使用者明示即代表對本 run 事前同意,範圍限於這一個 run；啟用細節與 resume 標記見 [references/unattended-mode.md](references/unattended-mode.md)。

## 會用到的工具

- `worktree-setup`: 需要隔離 worktree 時建立或重用 worktree，回傳 `path` / `branch` / `scope`
- `orchestrator`: 在目標 worktree 內跑 `intake → human gate → worker/review-map → runtime-preflight + test → done/halt`;測試前 runtime 依賴準備由 orchestrator 依 `runtime-preflight` 處理
- `auto-commit`: 只在 orchestrator `done` 後，且收尾策略要求本地 commit 時使用
- `worktree-teardown`: 只在 commit 成功後，或使用者明確要求清理時使用

## 不做的事

- 不手寫 manifest 狀態
- 不直接跑 worker
- 不直接跑 test runner
- 不直接安裝或共享 runtime 依賴;測試前環境準備交給 `runtime-preflight`
- 不自行 approve human gate;同意來源只能是使用者(`supervised mode` 的即時同意,或 `unattended mode` 啟動時的明示同意)
- 不自行決定進入 `unattended mode`;啟用只能來自使用者本次明示或既有 run 的 resume 標記
- 不做 push、PR、deploy 或任何 remote 操作

## 輸入

- 原始需求文字，後續 reviewer 必須看得到
- 目標 repo / worktree，預設目前工作目錄
- `commitType` 與 `scope`
- `base` 分支（可選）
- 是否要 commit(未指定時:隔離 worktree 預設要;目前 worktree 預設不要)
- 是否要 teardown(未指定時:本 flow 建立 / 重用的隔離 worktree 在 commit 成功後預設 teardown;目前 worktree 預設不要)
- 模式（可選）:`-u` 進 `unattended mode`、`-a` 強制 `supervised mode`;未明示時依「`supervised mode` / `unattended mode`」一節的判定順序

若需要建立 worktree 或 commit，但 `commitType` / `scope` 缺少，就先用保守方式推短 scope；推不出來才問使用者。

## 流程

1. **preflight triage**:判斷需求落在哪一檔。
   - 不進完整流程:單檔或少量明確修改、單一 bug、單一指令查證、單純 commit / worktree / PR / deploy 動作、或使用者明確要求「直接做」。
   - compact flow:低風險、單一 output ownership、需求已足夠明確、可由一個 worker 完成且有可靠 machine test。照完整流程的安全邊界跑,但要求 intake 使用 compact contract:一份 `intake-compact.md`、一個下游 implementation spec、一個整合 test；review depth 優先 `defer-until-signal` 或 `focused`。human gate 與真 test 保留。
   - 輕量流程:仍需多個 ownership 或 prototype-first,但工作同質性高、風險低。照完整流程跑,並把「輕量偏好」交給 intake:粗粒度合併、下游 spec 總數以 ≤5 為目標、review map 偏 `focused`,以單一整合終驗收斂。
   - 進完整流程:跨多檔或多階段、需求尚需拆解、驗收方式需要 human gate 接受、涉及多個 ownership、需要隔離 worktree + commit + teardown 串接。
   - 使用者明確要求小任務也跑完整流程時照跑,但要在 gate 摘要揭露成本較高。
2. 若 preflight 判定不進完整流程,停止 task-flow,改由呼叫端直接用一般工具完成該單步任務;不要建立 manifest。
3. 決定收尾策略:
   - 在目前 worktree 直接跑:預設 `commit:false`、`teardown:false`。
   - 由本 flow 建立 / 重用隔離 worktree:預設 `commit:true`、`teardown:true`。
   - 續跑既有 task worktree（已有 `orchestrator/manifest.json`，且不是使用者明確指定的目前 worktree 直跑）:視為隔離 worktree，預設 `commit:true`、`teardown:true`；commit context 缺失時可依 `auto-commit` 契約從當前分支 `<type>/<scope>` 回退推得。
   - 使用者明確指定 `commit` / `teardown` 時照指定值；`teardown:true` 仍須通過 `worktree-teardown` 的未提交工作防護。
4. 如果使用者指定在目前 worktree 直接跑，或已經在含 `orchestrator/manifest.json` 的 task worktree，就直接跑 orchestrator。
5. 否則先用 `worktree-setup` 建立或重用隔離 worktree，再在回傳的 `path` 內跑 orchestrator。
6. 若 `orchestrator/manifest.json` 已存在，視為唯一事實來源並續跑；若不存在，就把原始需求交給 orchestrator 進 intake。
7. orchestrator 回 `clarify`（human gate 以外）時，依當前模式的停點處理。
8. 遇到 human gate 時，依當前模式的停點處理。
9. orchestrator 回 `done` 後，先執行收尾策略，不把 `done` 直接當整條 task-flow 的最終交付:
   - `commit:true` → 在同一個 worktree 內呼叫 `auto-commit`，沿用 `worktree-setup` 回傳的 `scope` / `branch` 與 commit context；`orchestrator/` 過程產物只寫到 journal，不進交付 commit。
   - `commit:false` → 不呼叫 `auto-commit`；除非使用者明確要求，否則不 teardown，避免移除仍有未提交交付物的 worktree。
   - auto-commit 硬拒絕 → 停下回報原因；只有使用者明示「本來無需 commit」後，才可把 commit 收尾視為成功並繼續後續 teardown 判斷。
   - commit 成功且 `teardown:true` → 從主 checkout 或其他目錄呼叫 `worktree-teardown`；不要在要移除的 worktree 內執行 teardown。
10. orchestrator 回 `halt` 時，停止並回報 reason 與相關路徑。

## `supervised mode`（有人值守,預設）

- `clarify`（human gate 以外）:原樣轉問使用者，拿到答覆後再 resume。
- human gate:先讓使用者看 intake analysis / tasks / verification map / review map,特別是 `no-judge` 與降級審查項目,再依明確同意 resume。若 analysis 列有開放問題,同意前逐題訪談:一次一題並附 intake 建議答案;使用者可說「其餘照建議」。答案全數符合建議 → 直接 resume；任一偏離 → 收齊答覆後,把問答紀錄整份當修改意見 resume(單次重 intake,不逐題重派)。
- 「何時停下」各條成立時:同步轉問使用者。

## `unattended mode`（無人值守）

確定進入完整 task-flow、且目標 worktree 已確定後,第一步把啟用來源(使用者明示的原文或旗標)與時間寫進 `orchestrator/unattended/activation.json`;它同時是審計材料與 resume 標記。若 preflight triage 判定不進完整流程,不要建立 `orchestrator/` 或無人值守標記。

- `clarify`（human gate 以外）:一律不代答，停下整理停點資訊擱置回報——震盪 clarify 是引擎「我卡死了」的誠實訊號，是不得代答的紅線。
- human gate:依 [references/unattended-mode.md](references/unattended-mode.md) 跑 critic。只有符合嚴格低風險條件的 compact flow 可先用 1 個整合 critic；一般輕量／完整 flow 一律 3 critic。soundness 修到收斂才放行(上限 3 輪)。
- 「何時停下」各條成立時:不轉問、一律停下擱置回報，不得代答或代決。
- 交付時另附:critic 輪數與收斂結果、`orchestrator/unattended/` 審計材料位置、自動採用的答案清單，並提醒使用者於 merge 前審計。

## 共同規則

- `orchestrator/manifest.json` 是唯一事實來源
- `scope` 以 `worktree-setup` 回傳值為準，後續 commit / journal 必須沿用
- `orchestrator/` 只放過程產物，交付 commit 不應包含它
- runtime 依賴目錄與 preflight metadata 是執行產物,不進交付 commit;共享 cache / store 只允許 package manager 管理的 immutable / 併發安全層
- 不另外建立 flow state 檔；可恢復狀態以 worktree + branch + manifest 為準，模式標記以 `orchestrator/unattended/` 的審計材料為準
- orchestrator 的 `done` 只是任務圖完成；task-flow 的完成還包含本節收尾策略

## 何時停下

以下條件成立時必須停下；停下後的行為依 `supervised mode` / `unattended mode` 章節（`supervised mode` 轉問使用者、`unattended mode` 擱置回報）:

- 缺少會影響 worktree / commit 目標的關鍵資訊
- preflight 判定不值得完整 task-flow,但使用者要求的語意可能是「仍要完整自動化」
- orchestrator 回 `clarify`（human gate 以外）/ `halt`；human gate 依 `supervised mode` / `unattended mode` 章節的 gate 條目處理，不適用本節
- 使用者要求跳過 intake、human gate、reviewer、或可機器驗的真 test
- 使用者要求略過 intake 核准的 review map 或自動升級規則
- auto-commit 或 teardown 硬拒絕
- 需要 push、PR、deploy，或其他對外動作

## 交付

- 是否跑到 orchestrator `done`
- worktree path / branch / scope
- commit hash / message（若有）
- journal 分支（若有）
- teardown 是否執行
- 若停在 clarify / human gate / halt，列出要問的問題或要看的檔案
- `unattended mode` 時另附 critic strategy、實際 agent 呼叫數與「`unattended mode`」一節列的審計資訊

不要把 `result.json` 或 worker JSON 當成對使用者的成果；它們只是 orchestrator 內部交換格式。

## 自檢

- 已使用隔離 worktree，或明確遵循使用者要求的目前 worktree
- 已先做 preflight triage;若未進完整流程,沒有建立 manifest 或 worktree
- compact flow 只用於單一 ownership + 單 worker + 可靠 machine test；否則退回輕量或完整流程
- `scope` 已被後續 auto-commit / journal 沿用
- `orchestrator` 是唯一寫 manifest 狀態與決定下一步的站
- 模式依判定順序決定，停點行為符合對應章節:gate 未被憑空 approve、開放問題依模式處理（訪談或採建議）、紅線未被代答、`unattended mode` 的審計材料已寫入
- `unattended mode` 只由使用者本次明示或 resume 標記進入，非 agent 自行決定
- commit 只在 orchestrator `done` 後發生
- teardown 只在 commit 成功或使用者明確確認無需 commit 後執行，且必須通過 `worktree-teardown` 的未提交工作防護
