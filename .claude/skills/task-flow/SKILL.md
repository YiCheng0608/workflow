---
name: task-flow
description: >-
  通用任務引擎的入口流程。負責決定是否建立/重用隔離 worktree、呼叫 orchestrator、
  讓測試前 runtime-preflight 準備依賴環境，在 clarify / human gate 時轉問使用者，
  並在 done 後依收尾策略做本地 commit 與 teardown。
  不適用於單一步驟編輯、獨立 commit、獨立 worktree、push、PR、deploy，或任何要繞過
  intake、人類 gate、reviewer、真 test 的流程。
---

# task-flow

## 用途

把一個需求交給通用任務引擎完整跑完。task-flow 只管入口協調，不做任務實作、不拆任務、
不決定 routing。

進入完整流程前先做一次輕量 preflight triage。完整 task-flow 適合多階段、跨邊界、
需要驗證地圖或需要 commit / teardown 收尾的需求；明確單步任務不進完整流程。

## 會用到的工具

- `worktree-setup`: 需要隔離工作區時建立或重用 worktree，回傳 `path` / `branch` / `scope`
- `orchestrator`: 在目標 worktree 內跑 `intake → human gate → worker/review-map → runtime-preflight + test → done/halt`
- `runtime-preflight`: 測試前準備 worktree 內 runtime 依賴投影,並只共享安全的 cache / store
- `auto-commit`: 只在 orchestrator `done` 後，且收尾策略要求本地 commit 時使用
- `worktree-teardown`: 只在 commit 成功後，或使用者明確要求清理時使用

## 不做的事

- 不手寫 manifest 狀態
- 不直接跑 worker
- 不直接跑 test runner
- 不直接安裝或共享 runtime 依賴;測試前環境準備交給 `runtime-preflight`
- 不自行 approve human gate
- 不做 push、PR、deploy 或任何 remote 操作

## 輸入

- 原始需求文字，後續 reviewer 必須看得到
- 目標 repo / worktree，預設目前工作目錄
- `commitType` 與 `scope`
- `base` 分支（可選）
- 是否要 commit（未指定時:隔離 worktree 預設要 commit；目前工作樹預設不要自動 commit）
- 是否要 teardown（未指定時:本 flow 建立 / 重用的隔離 worktree 在 commit 成功後預設 teardown；目前工作樹預設不 teardown）

若需要建立 worktree 或 commit，但 `commitType` / `scope` 缺少，就先用保守方式推短 scope；推不出來才問使用者。

## 流程

1. **preflight triage**:判斷是否值得啟動完整 task-flow。
   - 不進完整流程:單檔或少量明確修改、單一 bug、單一指令查證、單純 commit / worktree / PR / deploy 動作、或使用者明確要求「直接做」。
   - 進完整流程:跨多檔或多階段、需求尚需拆解、驗收方式需要人類 gate 接受、涉及多個 ownership、需要隔離 worktree + commit + teardown 串接。
   - 使用者明確要求即使小任務也跑完整流程時照跑,但要在 gate 摘要揭露執行成本較高。
2. 若 preflight 判定不進完整流程,停止 task-flow,改由呼叫端直接用一般工具完成該單步任務;不要建立 manifest。
3. 決定收尾策略:
   - 在目前工作樹直接跑:預設 `commit:false`、`teardown:false`。
   - 由本 flow 建立 / 重用隔離 worktree:預設 `commit:true`、`teardown:true`。
   - 續跑既有 task worktree（已有 `orchestrator/manifest.json`，且不是使用者明確指定的目前工作樹直跑）:視為隔離 worktree，預設 `commit:true`、`teardown:true`；commit context 缺失時可依 `auto-commit` 契約從當前分支 `<type>/<scope>` 回退推得。
   - 使用者明確指定 `commit` / `teardown` 時照指定值；`teardown:true` 仍須通過 `worktree-teardown` 的未提交工作防護。
4. 如果使用者指定在目前工作樹直接跑，或已經在含 `orchestrator/manifest.json` 的 task worktree，就直接跑 orchestrator。
5. 否則先用 `worktree-setup` 建立或重用隔離 worktree，再在回傳的 `path` 內跑 orchestrator。
6. 若 `orchestrator/manifest.json` 已存在，視為唯一事實來源並續跑；若不存在，就把原始需求交給 orchestrator 進 intake。
7. orchestrator 回 `clarify` 時，原樣轉問使用者，拿到答覆後再 resume。
8. 遇到 human gate 時，先讓使用者看 intake analysis / tasks / verification map / review map，特別是 `no-judge` 與降級審查項目，再依明確同意 resume。
9. orchestrator 回 `done` 後，先執行收尾策略，不把 `done` 直接當整條 task-flow 的最終交付:
   - `commit:true` → 在同一個 worktree 內呼叫 `auto-commit`，沿用 `worktree-setup` 回傳的 `scope` / `branch` 與 commit context；`orchestrator/` 過程產物只交給 journal，不進交付 commit。
   - `commit:false` → 不呼叫 `auto-commit`；除非使用者明確要求，否則不 teardown，避免移除仍有未提交交付物的 worktree。
   - auto-commit 硬拒絕 → 停下回報原因；只有使用者明示「本來無需 commit」後，才可把 commit 收尾視為成功並繼續後續 teardown 判斷。
   - commit 成功且 `teardown:true` → 從主 checkout 或其他目錄呼叫 `worktree-teardown`；不要在要移除的 worktree 內執行 teardown。
10. orchestrator 回 `halt` 時，停止並回報 reason 與相關路徑。

## 共同規則

- `orchestrator/manifest.json` 是唯一事實來源
- `scope` 以 `worktree-setup` 回傳值為準，後續 commit / journal 必須沿用
- `orchestrator/` 只放過程產物，交付 commit 不應包含它
- runtime 依賴目錄與 preflight metadata 是執行產物,不進交付 commit;共享 cache / store 只允許 package manager 管理的 immutable / 併發安全層
- 不另外建立 flow state 檔；可恢復狀態以 worktree + branch + manifest 為準
- orchestrator 的 `done` 只是任務圖完成；task-flow 的完成還包含本節收尾策略

## 何時停下問使用者

- 缺少會影響 worktree / commit 目標的關鍵資訊
- preflight 判定不值得完整 task-flow,但使用者要求的語意可能是「仍要完整自動化」
- orchestrator 回 `clarify` / `halt`
- 使用者要求跳過 intake、人類 gate、reviewer、或可機器驗的真 test
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

不要把 `result.json` 或 worker JSON 當成對使用者的成果；它們只是 orchestrator 內部交換格式。

## 自檢

- 已使用隔離 worktree，或明確遵循使用者要求的目前工作樹
- 已先做 preflight triage;若未進完整流程,沒有建立 manifest 或 worktree
- `scope` 已被後續 auto-commit / journal 沿用
- `orchestrator` 是唯一寫 manifest 狀態與決定下一步的站
- commit 只在 orchestrator `done` 後發生
- teardown 只在 commit 成功或使用者明確確認無需 commit 後執行，且必須通過 `worktree-teardown` 的未提交工作防護
