# action 執行協議

只在準備委派 `produce` / `test`、執行 reviewer、組裝 `result.json`，或診斷失敗與震盪時讀本檔。日常 routing、bootstrap 與 human gate 不需要讀。

## reviewer protocol

worker 完成後依 human gate 核准的 `planning.review_map` 審查；未列一律 `full`。reviewer 不碰 manifest、`result.json` 或 routing，只挑戰、不代改。

- `full`：讀需求原文、任務描述、上游 outputs、實際 diff / 產物。`no-judge`、高風險、跨模組、權限、資料遷移、發布、需求含糊與重做一律使用。
- `focused`：仍讀需求原文與任務描述，以 handoff summary 作索引並抽查實際 diff / outputs。
- `defer-until-signal`：僅限低風險、ownership 清楚、`requires_test:true` 且有可靠 test。無 test、`no-judge`、`last_failure` 非空、worker 失敗或 outputs 越界時升級 `full`。

同輪、同 `tag` 且皆為 `focused` 的 spec 可合派 reviewer，逐 spec 回 verdict，共用 `orchestrator/review-<tag>-batch.md`。`full` 不合併。checklist 任務的 findings 必須標到具體項目。

reviewer 的事實來源是需求原文、任務描述、上游 outputs、實際產物 / diff 與測試證據；handoff、notes 與 intake-context 只作索引。採對抗式 framing：「假設產出已上線並出問題，反推失效方式」。

結論寫入 `orchestrator/review-<specId>.md`；回報只帶 verdict、record 路徑與一句重點：

```json
{ "ok": true, "outputs": ["..."], "review": { "depth": "full", "record": "orchestrator/review-spec-2.md" } }
```

合法 defer：

```json
{ "ok": true, "outputs": ["..."], "review": { "depth": "defer-until-signal" } }
```

審查失敗回 `{ "ok":false, "reason":"...", "fix_target":"code|spec" }`，或用 `blame` 指向上游。worker / reviewer 最多收斂 3 輪；仍失敗就照 produce 失敗記回。

## result.json

`result.json` 由 orchestrator 覆核轉錄，worker 不寫檔。使用單一 scratch 路徑覆寫，不保存 per-action JSON。

produce worker 回報：

```json
{ "ok": true, "outputs": ["..."], "deleted": ["..."], "usage": { "input_tokens": 0, "output_tokens": 0 } }
```

- `outputs` 是本站實際新增 / 修改的全部檔案；刪除列入 `deleted`。
- `retained_outputs` 只供 `review_gate` spec 重做使用:列上一版 outputs 中本輪未修改、要原樣沿用的檔案。CLI 會驗證它們確實屬於上一版、與 `outputs` 不重疊、仍存在,且內容與上次記回時落盤的基準雜湊(spec 的 `output_hashes`)一致,再合併存回 spec outputs;一般 worker 不得使用。
- 本站失敗：`{ "ok":false, "reason":"...", "fix_target":"code|spec" }`。
- 根因在上游：`{ "ok":false, "reason":"...", "blame":"spec-x" }`。
- `usage` 選填；host 能取得時才填非負整數 token 數。
- `review` 由 orchestrator 在 reviewer 收斂後補上。

test worker 回報：

```json
{ "pass": false, "altitude": "spec", "blame": "spec-2", "reason": "...", "evidence": { "expected": "...", "actual": "..." } }
```

- `altitude`：`code` 實作錯；`spec` 規格錯並 cascade；`requirement` 需求欠明確；`environment` 基礎設施錯且不可帶 `blame`。
- `blame` 選填，省略時為 test 的 `verifies`；可直接指任一上游 spec。
- `reason` 是 string；結構化細節放 `evidence`。
- `env_patch` 只可寫 `env_patchable` 白名單。
- `pass:true` 必須有非空 evidence。unit 必帶 `{ command, exit_code:0, passed, failed }`，且 `passed>=1`、`failed===0`。
- 舊 `{ "pass":false, "verdict":"code|spec" }` 仍相容。

CLI 會硬驗 schema、lease、review depth、record / outputs 存在性、git dirty 對帳、ownership、test evidence、`env_patch` 與 `requires_test`。驗不過時 manifest 不變、turn 不增；依錯誤修正 JSON 後重送。

## 歸咎與環境失敗

produce / test 都應歸咎到真正需要修改的 spec，而非當下站點。`blame` 指 intake spec 代表退回重 intake。

produce 遇到環境或 worker crash 時，不要用 `ok:false` 觸發內容重做；短暫重試仍失敗就停下回報。test 的環境失敗使用 `altitude:"environment"`，由引擎建立 environment clarify。

同一 `{target, altitude}` 累計 `noProgressK` 次會轉 `clarify`；`maxTurns` 超過則 `halt`。任何可取得的 machine test 都必須實跑，不以 reviewer 取代。
