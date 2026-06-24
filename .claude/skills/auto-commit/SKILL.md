---
name: auto-commit
description: flow 無關的 commit 站。輸入 commit context（commitType、scope、ticketId、commitMode）、交付物挑檔規則與可選的過程紀錄清單，在當前 repo/worktree 產生本地 Conventional Commit；可選發佈過程紀錄到孤兒 journal 分支。預設模式收程式碼與測試檔、排除過程產物；initial 模式收綠地鷹架交付物；declared 模式照呼叫端提供的聲明交付清單收檔。全程 local，不建分支、不切分支、不 push、不碰 remote。Use when deliverables need a local commit; do not use to create branches, run a pipeline, push, or open PRs.
---

# auto-commit

## 用途

本站做 commit。它吃呼叫端提供的 commit context 與挑檔規則，在**當前分支**產生本地 commit；若有提供過程紀錄清單，另發到 journal 分支。它做兩件事,都**全程 local**:

1. **commit 交付物**:依模式挑出交付檔並 `git add`,以 **Conventional Commit** 格式 commit 到**當前分支**。
2. **發佈過程紀錄**:把呼叫端提供的過程紀錄檔清單發到一條**孤兒分支 `journal/<scope>`**。它與交付分支毫無交集、**永不 merge 回 dev**,所以交付分支保持純交付物,而過程紀錄仍持久可回看。

## 前提（由呼叫端 / flow 保證,本站依賴而不重複）

- **分支已準備好**:本站**不建分支、不切分支、不加 collision 尾碼**。呼叫端須在進入本站前讓 repo 位於應提交的分支。
- **工作樹範圍可判定**:預設模式假設工作樹從乾淨開始；declared 模式則以呼叫端提供的聲明交付清單為權威。
- **commit type / scope 由 commit context 提供**。本站**不從 diff 推 type**(不看 `??`/`M`)。

## 輸入

- **commit context**(必須):`commitType`、`scope`；`ticketId` 選填；`commitMode` 選填(`default` / `initial` / `declared`)。
- **專案根目錄**(必須):要執行 git commit 的 repo/worktree。
- **聲明交付清單**(declared 模式必須):應進 commit 的交付檔路徑；可包含文件交付物。
- **過程紀錄清單**(選填):要發佈到 journal 的摘要 / 審計檔路徑。
- **short description 來源**(選填):需求摘要、技術選型 ADR 標題、定位確認單標題、或呼叫端提供的一句描述。

> 萬一 `commitType` / `scope` 缺失:退回從 `git branch --show-current` 解析當前分支的 `<type>/<scope>`(把第一個 `/` 前當 type、後當 scope),並在「警告」區塊註明是回退推得。

## 何時使用

觸發條件(全部需同時成立):
- 呼叫端觸發 auto-commit 的執行動作。
- commit context 與挑檔模式已提供。
- 工作樹至少有一個可提交的交付物變更。

不要在這些情境使用:
- 交付物尚未完成。
- 需要建立分支或初始化 repo。
- 需要 push 到 remote / 開 PR(後續人工)
- 使用者只想預覽 commit message、不執行 commit

## Commit Message 格式

遵照 **Conventional Commits**,先偵測專案既有風格(`git log --oneline -10`)對齊後套用:

```
<commitType>(<scope>): short description
```

例:`feat(dashboard): implement usage stats panel`
例:`feat(PROJ-123): implement user profile card`(scope 為 ticketId 時)

- `commitType` / `scope` 直接取自 commit context,**不在本站重新判斷**。
- **short description**:imperative mood(英文),整行含前綴 ≤72 字元;描述本次主要交付內容。來源優先使用呼叫端提供的一句描述；缺席時才從輸入摘要或交付檔路徑名稱推斷。

## 執行前判斷與例外處理

**硬拒絕**(不執行 commit、回報說明文字、不寫任何檔):
- 工作樹挑不到任何程式碼或測試檔變更(篩掉 `.md` 後候選為空)→ 回報「no code/test changes found to commit」
- `git status --porcelain` 顯示有**已 staged** 的變更 → 警告並停下,不執行任何 `git add`,要求人工確認後再重跑（auto-commit 前不應已有 staged 變更；若有，代表外部手動 stage 了不相關變更）

> **硬拒絕怎麼處置**:auto-commit 沒有 test。硬拒絕時不要把它記成成功；把本站說明交給呼叫端。合法出口只有兩種:**修好原因 → 重跑**；或**明示「本來無需 commit」→ 呼叫端可視為成功**。

## 模式:initial(`commitMode === "initial"`)

綠地前提不同,以下幾點**覆寫**預設行為;未提到的(staged 先擋、journal 發佈、硬拒絕處置、local 界線、輸出結構)**全部照舊**:

- **前提差異**:repo 位於初始分支(`main`)、這將是**第一個 commit**。「工作樹從乾淨開始」的保證改由「初始 repo 中一切 untracked 皆為本次鷹架交付物」提供。
- **挑檔規則(關鍵差異)**:收**全部鷹架交付物**——code、test、設定檔、lockfile、**README / AGENTS.md / CLAUDE.md(symlink,git 可正常追蹤)等 `.md` 交付物**——排除 `orchestrator/` 過程目錄與**執行產物**(`node_modules/`、`dist/` 等 build 輸出、coverage)。執行產物是**硬排除、不依賴 `.gitignore`**:smoke 驗證通常已實跑 install / build,工作樹可能有這些東西;`.gitignore` 正常時它們不會出現在 `git status --porcelain`,但萬一鷹架的 `.gitignore` 缺漏,本站也**不得**把它們收進 initial commit(porcelain 出現 `node_modules/` 之類即為 `.gitignore` 缺漏的訊號,如實記進「警告」)。預設模式「排除一切 `.md`」的規則在 initial 模式**不適用**(README 是交付物不是過程產物)。
- **分支確認**:**不**檢查 `<commitType>/<scope>`;確認當前在初始分支(`main`)即可,不建分支、不切分支。
- **short description 來源**:需求摘要第一行 / 技術選型 ADR 標題 / 呼叫端提供描述。例:`feat(my-app): bootstrap react+vite project skeleton`。
- **journal 照舊**:若呼叫端提供過程紀錄清單,照樣發 `journal/<scope>`(同一個 repo 裡的孤兒分支,永不 merge 回 main)。
- **自檢差異**:「commit 內無任何 `.md`」改為「**commit 內不含 `orchestrator/` 下任何檔,也不含執行產物**」(`git show --name-only HEAD` 無 `orchestrator/`、`node_modules/`、build 輸出目錄等前綴路徑);README / AGENTS.md / CLAUDE.md(symlink)**應在** commit 內,缺了反而是漏。

## 模式:declared(`commitMode === "declared"`)

前提與預設模式相同(隔離 worktree、分支 `<type>/<scope>`、工作樹從乾淨開始),**差異只在挑檔規則**;未提到的(staged 先擋、分支確認、journal 發佈、硬拒絕處置、local 界線、輸出結構)**全部照預設模式**:

- **挑檔規則(關鍵差異)**:commit 內容 = ① **聲明交付清單**:呼叫端提供的交付檔路徑,排除 `orchestrator/` 前綴後的路徑；② **聯集測試檔**:`git status --porcelain` 中命中 `*.test.*` / `*.spec.*` / `__tests__/` 的變更檔。declared 模式允許聲明交付清單內的 `.md` 交付物；未被聲明且不屬測試檔的變更不收。過程摘要 / 本站自己的 `.md` 摘要是過程紀錄,只發 journal,不進交付 commit。
- **聲明檔核對**:聲明交付清單(①)中每個路徑都應存在於工作樹且在 `git status --porcelain` 有變更紀錄;**聲明了卻無變更 / 不存在** → 硬拒絕(揭露哪個路徑對不上——可能落地站漏做或外部動過碼);反向地,porcelain 裡**有變更卻不在 ①∪②** 的檔(排除 `orchestrator/` 與 `.md` 過程產物)→ 不收,但如實記進「警告」(落地站可能漏聲明,人工確認)。
- **short description 來源**:呼叫端提供的確認單標題 / 任務描述。例:`fix(login): update quick-login button copy`、`docs(readme): correct setup steps`。
- **自檢差異**:「commit 內無任何 `.md`」改為「**commit 內容 = 聲明交付清單 ∪ 測試檔**」(`git show --name-only HEAD` = ①∪②;無 `orchestrator/` 前綴路徑;`.md` 在聲明交付清單內即合法;有 unit test 的場景測試檔**應在** commit 內,缺了反而是漏)。

## 路徑約定

被叫起來時 harness 會給本 skill 的 base directory(形如 `…/skills/auto-commit`),以下用 `$SKILL_DIR`。journal 發佈腳本固定在 `$SKILL_DIR/scripts/journal-publish.js`。

## 處理步驟

1. **讀 commit context**:取得 `commitType` / `scope` / `ticketId` / `commitMode`。缺失則走「萬一缺失」回退(解析當前分支),並記警告。
2. **確認在對的分支**:`git branch --show-current` 應為 `<commitType>/<scope>`。不符 → 記進「警告」(可能不在預期 worktree),但不自行切換。(**initial 模式**:改確認在初始分支 `main`,不適用 `<type>/<scope>` 檢查。)
3. **檢查 staged(先擋,在挑檔之前)**:`git status --porcelain` 若有**任何**已 staged 的 paths → **硬拒絕並說明**,不做任何後續挑檔 / `git add`(乾淨工作樹前提下,已 staged 代表外部介入;**先擋下才不會把外部 staged 變更混進候選判斷**)。
4. **挑出要 commit 的交付檔**:`git status --porcelain` 取變更/新增路徑,依模式篩選。預設模式篩出程式碼與測試檔、排除所有 `.md` 與整個 `orchestrator/` 工作目錄；initial / declared 模式依各自規則。候選為空 → 硬拒絕。
5. **生成 short description**:優先讀呼叫端提供描述；缺席時從輸入摘要或交付檔路徑推斷。
6. **偵測既有 commit 風格**:`git log --oneline -10` 校準格式。
7. **git add**:`git add <挑出的程式碼/測試檔列表>`(逐一 add,**不用 `git add .`**,以免吞入 `.md` 或非預期變更)。
8. **git commit**(當前分支):`git commit -m "<commitType>(<scope>): <description>"`。
9. **取得 commit hash**:`git log -1 --format="%H %h %s"`。
10. **發佈過程紀錄到 `journal/<scope>`**:將呼叫端提供的**過程紀錄清單**交給腳本——
    ```
    node "$SKILL_DIR/scripts/journal-publish.js" --scope <scope> -- <檔1> <檔2> ...
    ```
    腳本用底層 plumbing 把這些檔提交到孤兒分支 `journal/<scope>`(已存在則接一個新 commit、保留先前紀錄;tree 內**保留相對路徑**如 `<scope>/orchestrator/triage.md`,不同站同名檔不會互相覆蓋),**全程不 checkout、不碰當前工作樹**。解析回傳 JSON 取 `branch` / `commit`。
    > **journal 收檔規則**:`orchestrator/` 不進交付物 commit,但呼叫端提供的過程紀錄清單要進 journal 分支作為審計紀錄。
11. **輸出固定結構 Markdown 摘要**,依自檢清單確認後交付。

## 輸出

固定結構 Markdown 摘要(6 個 H2 區塊)

```
## Commit(交付物)

- **分支**: <commitType>/<scope>(當前 worktree 分支,由隔離工作區建立器建立)
- **hash**: <short-hash>（full: <long-hash>）
- **message**: `<full commit message>`

## Staged 檔案清單

- `<path>` [added|modified]
- ...

## 過程紀錄(發到 journal)

- **journal 分支**: journal/<scope>（commit: <short-hash>;永不 merge 回 dev）
- 已發佈的過程產物：
  - `<path>` → `journal:<scope>/<相對路徑>`
  - ...

## 範圍外 / 後續

- merge `<commitType>/<scope>` 回 dev：人工操作（純 code，無 md，零手動移除）
- push 分支 / 開 PR：人工操作（本 flow 不做）

## 後設資訊

- commitType / scope 來源：commit context（或：回退解析當前分支）
- ticketId：<ticketId 或 未提供>
- short description 來源：<呼叫端提供描述 ｜ 輸入摘要 ｜ 交付檔路徑推斷>
- staged 檔案數：<n>；發到 journal 的 md 數：<m>

## 警告

（若有 staged 衝突、不在預期分支、env 缺失回退、或其他警告則列出；否則「無」）
```

## 輸出前自檢

- commit 落在當前 worktree 分支(`git branch --show-current` = `<commitType>/<scope>`;**initial 模式**:= 初始分支 `main`);本站**沒有**建分支、切分支、加尾碼
- **commit 內只含程式碼與測試檔,無任何 `.md`**(`git show --name-only HEAD` 不含 `.md`)(**initial 模式**:改驗「不含 `orchestrator/` 下任何檔、不含 `node_modules/` 等執行產物,且 README / AGENTS.md / CLAUDE.md(symlink)在 commit 內」;**declared 模式**:改驗「commit 內容 = 聲明交付清單 ∪ pattern 命中的測試檔、無 `orchestrator/` 前綴路徑,`.md` 在聲明交付清單內即合法」)
- staged 檔案清單與 `git show --name-only HEAD` 一致
- commit message 格式符合 Conventional Commits,`type`/`scope` 取自 commit context(或回退已註明)
- 過程 `.md` 已透過 `journal-publish.js` 發到 `journal/<scope>`,**未**進 feature 分支;`git log journal/<scope> -1` 可見
- 全程 local:未 `git push`、未設 upstream、未開 PR、未改外部編排狀態、未自行推進流程
- 若 commit context 缺失走了回退、或不在預期分支,已在「警告」誠實揭露
