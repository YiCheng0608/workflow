---
name: worktree-setup
description: flow 無關的隔離工作區建立器。吃一個 commit type（feat / fix / refactor …）與一個 scope，跑 scripts/worktree.js 以「當前分支（或指定 base）」為起點 `git worktree add` 出一個獨立目錄＋新分支（分支名 = `<type>/<scope>`，scope 已 sanitize；collision 自動加尾碼 -2/-3…；已有 worktree 掛在目標分支上則冪等重用）——讓多個 task 能在同一個 repo 同時跑而互不污染檔案。全程 local，不 push、不碰 remote。回傳 worktree 路徑、最終分支與最終 scope（含尾碼）：路徑供呼叫端進入該目錄執行，scope 供後續 commit 沿用作 commit scope 與 journal 分支。Use when a task needs its own isolated git worktree + branch before running a flow; do not use to commit, to run the pipeline itself, or for any remote / push operation.
---

# worktree-setup

## 用途

把「一個 task 一個隔離工作區」這件事獨立成一個 skill。它跑 `scripts/worktree.js`，以**當前分支（或 `--base` 指定的分支）為起點**,`git worktree add` 出一個**獨立目錄 + 新分支**,分支名 = `<type>/<scope>`。

它存在的理由是:**同一個 repo 要同時跑多個 task**。一個 git repo 只有一份工作樹,多個 task 若擠在同一個目錄,就算各自切不同分支,磁碟上的檔案還是糾在一起。worktree 給每個 task 一個**獨立目錄**,才是真正的平行隔離。

**它與 flow 完全無關**:只認 `type` + `scope`,不知道之後要跑哪條 pipeline。分支命名規則只住在這裡。

**全程 local**:`git worktree add` 建目錄 + 新分支,**不 push、不設 upstream、不碰 remote**。

## 何時使用

- 一條 task 開始前,需要先有專屬的隔離工作區。

不要在這些情境使用:
- 要 commit / 跑 pipeline 本身(那是後續 commit / 編排器的事)。
- 任何 push / 對 remote 的操作。

## 路徑約定

被叫起來時 harness 會給這個 skill 的 base directory(形如 `…/skills/worktree-setup`),以下用 `$SKILL_DIR` 代表。腳本固定在 `$SKILL_DIR/scripts/worktree.js`。

## 介面

```
node "$SKILL_DIR/scripts/worktree.js" --type <type> --scope <scope> [--base <branch>] [--root <dir>]
```

- `--type`(必填):commit type,即分支前綴。`feat` / `fix` / `refactor` …由呼叫端宣告。
- `--scope`(必填):分支與後續 commit 的 scope。**呼叫端要先決定好最終 scope 字串再傳進來**,腳本只做 sanitize,不做語意生成。
- `--base`(選填):新分支以哪條分支為起點。預設 = 當前分支(`git rev-parse --abbrev-ref HEAD`)。
- `--root`(選填):worktree 目錄放哪。預設 = `<repo 同層>/<repoName>.worktrees/`,每個 task 一個子目錄 `<type>-<scope>`。

### scope 責任邊界

腳本只 sanitize,不臆造 scope。scope 的來源、命名優先序與是否沿用 ticket id 都由呼叫端決定；本站只保證最終分支、回傳 scope 與 worktree 目錄一致。回傳的 `path` / `branch` / `scope` 應由呼叫端寫入自己的流程狀態或 manifest,不要讓後續站重新推算。

## 輸出

stdout 一行 JSON:

```json
{ "branch": "feat/dashboard", "path": "/abs/path/to/worktree", "base": "main",
  "scope": "dashboard", "reused": false, "collision": false }
```

- `branch`:最終分支名(含 collision 尾碼,如 `feat/dashboard-2`)。
- `path`:worktree 的絕對路徑——**呼叫端接著要 `cd` 進這裡執行**。
- `scope`:**最終 scope**(含尾碼)。後續 commit 沿用這個值作 commit scope 與 `journal/<scope>`,確保三者(分支 / commit / journal)一致。
- `reused`:`true` 代表目標分支已有 worktree,直接重用(冪等)。
- `collision`:`true` 代表原 scope 撞名,已加尾碼。

## 行為規則

- **冪等重用**:若已有 worktree 掛在 `<type>/<scope>`(同一 task 重入)→ 不重建,回傳既有路徑(`reused:true`)。
- **collision**:`<type>/<scope>` 分支已存在但沒掛 worktree → 加尾碼 `-2`/`-3`…直到不衝突(`collision:true`);尾碼分支若已有 worktree 也重用。
- **不刪不切既有東西**:不刪分支、不動使用者當前所在分支(只 `add` 新 worktree)。

## 自檢

- 回傳的 `path` 確實存在且是個 worktree(`git worktree list` 看得到)。
- 回傳的 `branch` = `<type>/<scope>`(含尾碼則一致),且 `scope` 欄位與分支尾碼一致。
- 全程 local:沒有 `git push`、沒有設 upstream、沒有碰 remote。
