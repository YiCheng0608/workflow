---
name: worktree-teardown
description: 隔離工作區建立器的逆操作:安全移除一個 task 的隔離 worktree。跑 scripts/teardown.js，用 ground truth（git status 扣掉過程產物約定目錄 orchestrator/）判斷「有沒有未提交的工作」——有未提交工作（含 orchestrator/ 以外的 .md，它們不進 journal、移除即遺失）就拒絕移除，沒有才用 --force 跨過 orchestrator/ 過程噪音安全移除。預設只移除 worktree、**不刪分支**：task 分支（含 commit）與孤兒 journal 分支都保留；要刪 task 分支用 --delete-branch（預設 -d 安全刪，未 merge 會拒絕）。全程 local。Use when a task's worktree should be cleaned up safely — either right after a successful commit keeping the branch for later merge, or after the branch has been merged; do not use to remove a worktree that still has uncommitted code (it refuses by design), to delete the journal branch by default, or for any remote operation.
---

# worktree-teardown

## 用途

把一個 task 跑完、用不到的隔離 worktree **安全移除**。它是隔離工作區建立器的逆操作。

**為什麼需要它、而不是直接 `git worktree remove`**:過程產物（摘要、狀態檔等，**約定一律放 `orchestrator/` 底下**、通常已發進 journal）永遠以 untracked 殘留,會讓 `git worktree remove`(不加 `--force`)**一律拒絕**——「成功(code 已 commit、只剩過程噪音)」與「失敗(code 沒 commit)」在 git 眼裡一樣髒,**分不出來**。若你養成「反正加 `--force`」的習慣,失敗路徑沒提交的 code 就會被一起清掉。

本 skill 自己用 **ground truth** 判斷:`git status` 扣掉整個 `orchestrator/`(過程產物的約定目錄)= **未提交的工作**。注意 `orchestrator/` **以外**的 `.md`(README、docs 等)**算未提交工作、不算噪音**——它們不會進 journal,移除即遺失,所以一律觸發拒絕、由人決定(回傳的 `processNoise` 列出被視為噪音跨過的路徑,可供核對)。

- 有未提交 code → **拒絕移除**(work 會遺失),除非明確 `--force`。
- 沒有 → 用 `--force` 跨過 `orchestrator/` 過程噪音**安全移除**(安全性已自行確認)。

這正好對上「**成功才移除、失敗要擋**」:交付 commit 成功後 code 都進了分支、只剩 `orchestrator/` 過程產物 → 乾淨移除；commit 失敗或未執行時 code 還在工作樹未提交 → 擋下。

## 何時使用

兩種情境(預設都保留分支、只拆工作目錄):

- **commit 成功後清理**:交付物已安全在分支上、工作目錄只剩過程噪音時，移除 worktree 並保留 task 分支供日後 merge。要續做可再 `git worktree add` 掛回。
- **手動清理**:task 真的告一段落(常見是已 `git merge` 回 dev)時,清掉用不到的 worktree。

清理前提是 orchestrator 已完成該 task 的驗證與收尾；只要還需要保留這個 worktree 來跑 review、測試、或回頭補資料，就不要提早 teardown。

不要在這些情境使用:
- worktree 還有未提交的 code(本 skill 設計上會拒絕;請先 commit)。
- 想刪 journal 分支(預設保留——它是持久審計紀錄;真要刪才加 `--delete-journal`)。
- 任何對 remote 的操作。

> **不要在要被移除的那個 worktree 內執行**——git 不能移除「當前所在」的 worktree。請在主 checkout(或別的目錄)裡跑。

## 路徑約定

被叫起來時 harness 會給本 skill 的 base directory(形如 `…/skills/worktree-teardown`),以下用 `$SKILL_DIR`。腳本固定在 `$SKILL_DIR/scripts/teardown.js`。

## 介面

```
node "$SKILL_DIR/scripts/teardown.js" --branch <type>/<scope> [--path <wt>]
     [--merged-into <branch>] [--delete-branch] [--delete-journal] [--force]
```

- `--branch`(或 `--path`,擇一必填):要移除的 worktree 對應的分支(如 `feat/dashboard`),或直接給 worktree 路徑。
- `--merged-into <branch>`(選填):檢查 feature 分支是否已 merge 進該分支(如 `dev` / `main`),結果回報在 `merged`;也作為 `--delete-branch` 是否安全的依據。
- `--delete-branch`(選填):移除 worktree 後一併刪 feature 分支。預設 `git branch -d`(**未 merge 會拒絕**);配 `--force` 則 `-D` 強刪。
- `--delete-journal`(選填):連同刪 `journal/<scope>`。**預設不刪**(保留審計紀錄)。
- `--force`(選填):略過「未提交 code」防護(會丟棄那些變更),且 branch 刪除改用 `-D`。**慎用**。

## 輸出

stdout 一行 JSON:

```json
{ "removed": true, "path": "/abs/wt", "branch": "feat/dashboard", "scope": "dashboard",
  "uncommittedCode": [], "processNoise": ["orchestrator/state.json", "orchestrator/triage.md"],
  "merged": true, "branchDeleted": false,
  "branchDeleteSkipReason": null, "journalBranch": "journal/dashboard",
  "journalKept": true, "journalDeleted": false }
```

- `removed`:`false` 且帶 `reason` = 找不到對應 worktree(可能已移除;冪等)。
- `uncommittedCode`:被偵測到的未提交工作路徑(成功路徑應為空)。
- `processNoise`:被當過程噪音跨過的 `orchestrator/` 路徑,供核對「跨過的真的只有過程產物」。
- `merged`:`--merged-into` 給定時才有值。
- `journalKept`:預設 `true`——`journal/<scope>` 保留,供日後回看。

## 典型用法

**A. commit 成功即清——保留分支,稍後再 merge:**
```
# 在主 checkout(不能在要移除的 worktree 內):只拆工作目錄,分支與 journal 都留著
node "$SKILL_DIR/scripts/teardown.js" --branch feat/dashboard
```

**B. merge 後清理——連已合併的 feature 分支一起刪(journal 仍保留):**
```
git merge feat/dashboard                                   # 主 checkout 先合併
node "$SKILL_DIR/scripts/teardown.js" --branch feat/dashboard --merged-into dev --delete-branch
```

## 自檢

- 移除前已用 ground truth 確認沒有未提交 code(`uncommittedCode` 為空),或使用者明確 `--force`。
- 不是在被移除的 worktree 內執行。
- 預設**沒有**刪 journal 分支;feature 分支只有在 `--delete-branch` 時才刪、且未 merge 時(無 `--force`)會拒絕。
- 全程 local:沒有任何 push / remote 操作。
