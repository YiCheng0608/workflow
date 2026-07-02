---
name: runtime-preflight
description: 在隔離 worktree 內跑 unit / integration / e2e 等機器測試前準備 runtime 依賴環境。偵測 Node、Python、PHP、Go、Rust、Ruby、Docker 等專案的 lockfile / manifest,建立或重建 per-worktree 可變投影(node_modules、.venv、vendor、target 等),並只共享 immutable / package-manager-owned cache 或 store。Use before test workers run commands in a worktree; do not create worktrees, run the final test verdict, commit, push, or mutate manifest directly.
---

# runtime-preflight

## 用途

在測試 worker 跑真測試前,先把目標 worktree 的 runtime 依賴環境準備到可執行狀態。它解決的是「隔離 worktree 需要測試,但不希望每個 worktree 都完整重複下載 / 展開依賴」。

核心規則:

- **每個 worktree 保留自己的可變投影**:例如 `node_modules/`、`.venv/`、`vendor/`、`target/`、compose project state。
- **只共享 package manager 管理的 immutable / 併發安全 cache 或 store**:例如 pnpm store、pip / uv cache、Composer cache、Go module cache、Cargo registry cache、Docker image layer、Playwright browser cache。
- **不得預設 symlink 可變投影目錄**:不要把多個 worktree 指到同一份 `node_modules`、`.venv`、`vendor` 或 `target`。

## 何時使用

- orchestrator 收到 `test` action,且該 test 需要在 worktree 內執行命令。
- 測試 worker 要啟動 dev server、integration service、browser e2e、CLI smoke 或任何依賴 runtime 套件的真測試。
- worktree 是新建 / 重用的,不確定依賴投影是否存在或是否仍符合 lockfile。

不要在這些情境使用:

- 建立或移除 worktree(那是 `worktree-setup` / `worktree-teardown`)。
- 跑正式測試並判定 pass / fail(本站只做測試前準備;test verdict 仍由測試 worker 產生,再由 orchestrator 經 `cli.js test` 記回)。
- commit、push、PR、deploy 或對外發布。
- 把 cache / store 的狀態寫成任務完成證據取代真 test evidence。

## 工作流程

1. **定位 worktree 根目錄**:在 orchestrator / task-flow 傳入的目標 repo 或 worktree 內執行;不要在主 checkout 偷跑。
2. **偵測 runtime**:用 lockfile / manifest 判斷需要哪些 adapter。常見訊號:
   - Node:`pnpm-lock.yaml`、`package-lock.json`、`yarn.lock`、`package.json`
   - Python:`uv.lock`、`poetry.lock`、`requirements*.txt`、`pyproject.toml`
   - PHP:`composer.lock`、`composer.json`
   - Go:`go.mod`、`go.sum`
   - Rust:`Cargo.lock`、`Cargo.toml`
   - Ruby:`Gemfile.lock`、`Gemfile`
   - Docker:`Dockerfile`、`compose.yaml`、`docker-compose.yml`
3. **計算投影 fingerprint**:至少包含 lockfile / manifest hash、runtime 版本、package manager 名稱與版本、OS / arch、native ABI 相關版本與重要 install flags / env。不能只看 lockfile。
4. **檢查 worktree 內投影**:若缺投影、fingerprint 不符、或偵測到上次 install 未完成,就重建或修復投影。
5. **使用共享 cache / store install**:install 可共享 manager-owned cache / store,但輸出投影留在 worktree 內。
6. **回報 preflight evidence**:把實際做了什麼、fingerprint、共享 cache / store 路徑、是否重建投影、風險或降級寫進 test worker 的 evidence / env_patch。本站不直接寫 manifest。

## Fingerprint

dependency projection 的 fingerprint 至少包含:

- lockfile / manifest hash:例如 `pnpm-lock.yaml`、`package-lock.json`、`uv.lock`、`poetry.lock`、`requirements*.txt`、`composer.lock`、`go.sum`、`Cargo.lock`、`Gemfile.lock`
- runtime:例如 Node / Python / PHP / Go / Rust / Ruby 版本
- package manager:例如 pnpm / npm / yarn / uv / pip / poetry / composer / cargo / bundler 版本
- platform:OS、CPU arch、libc / shell 或容器基底等會影響 native binary 的資訊
- native ABI:例如 Node ABI、Python minor version、PHP extension ABI
- install mode:dev / production、optional deps、workspace filter、extra index、feature flags、環境變數
- workspace 設定:`pnpm-workspace.yaml`、`.npmrc`、`.yarnrc.yml`、`pyproject.toml`、`composer.json` 等會影響 dependency graph 的檔案

fingerprint 可以用檔案寫在 worktree 內的過程產物約定目錄下,例如 `orchestrator/runtime-preflight/<runtime>.json`。這類檔案是過程 / cache metadata,不進交付 commit;必須放在 `orchestrator/` 底下,否則 `worktree-teardown` 會把它判成未提交工作而拒絕清理。

## Runtime 策略

| 生態 | worktree 內保留 | 可共享 |
|---|---|---|
| Node / pnpm | `node_modules` 投影 | pnpm store / global virtual store、下載 cache、Playwright browser cache |
| Node / npm | `node_modules` | npm cache |
| Node / yarn | `node_modules` 或 yarn PnP 狀態 | yarn cache |
| Python | `.venv` 或專案虛擬環境 | pip / uv / poetry cache、wheel cache |
| PHP | `vendor/` | Composer cache |
| Go | 通常不需要 per-worktree vendor | Go module cache、build cache |
| Rust | `target/` 或 per-worktree target | Cargo registry / git cache;共享 target 需 fingerprint key,預設保守 |
| Ruby | bundle path / vendor bundle | Bundler cache |
| Docker | compose project name / volume 命名隔離 | image / layer cache、build cache |

## 併發與污染防護

- 共享層必須由 package manager 或 runtime 自己管理併發與完整性;不要自己用裸 symlink 拼共享 store。
- 如果工具會就地改寫 dependency tree 或 build output,不要讓它改到共享 store。常見訊號包括 `patch-package`、native rebuild、手寫 postinstall、會修改 `node_modules` 內容的 codegen。
- 偵測到可能污染共享層時,改走保守策略:per-worktree copy、停用 risky hardlink 模式、強制重建投影,或把測試標成 environment 失敗並說明需要人工決策。
- 多個 test 平行跑同一個 worktree 時,避免同時 install。若沒有可用鎖機制,同一 worktree 的 preflight / install 以序列方式執行。

## 回報格式

本站沒有自己的 manifest action。它的結果應併入測試 worker 的回報,供 orchestrator 寫入 `cli.js test` 的 `result.json`。

成功時,test worker 的 evidence 可包含:

```json
{
  "preflight": {
    "runtimes": ["node"],
    "projection": "node_modules",
    "fingerprint": "sha256:...",
    "install_command": "pnpm install --frozen-lockfile",
    "cache_store": "pnpm store",
    "rebuilt": false,
    "shared_layers": ["pnpm-store", "playwright-browsers"]
  }
}
```

若 preflight 自身失敗,測試 worker 應回報:

```json
{
  "pass": false,
  "altitude": "environment",
  "reason": "runtime preflight failed: ...",
  "evidence": {
    "preflight": {
      "runtimes": ["python"],
      "command": "uv sync --frozen",
      "exit_code": 1,
      "stderr_excerpt": "..."
    }
  }
}
```

`altitude:"environment"` 不帶 `blame`;由 orchestrator 經 `cli.js test` 記回後停在 environment clarify。
