# CLI interface

只在呼叫 `cli.js`、解析 action，或診斷 CLI protocol 時讀本檔。

```sh
node "$SKILL_DIR/scripts/cli.js" next     $MANIFEST
node "$SKILL_DIR/scripts/cli.js" next-all $MANIFEST [--limit N]
node "$SKILL_DIR/scripts/cli.js" produce  $MANIFEST <specId> <result.json>
node "$SKILL_DIR/scripts/cli.js" test     $MANIFEST <testId> <result.json>
node "$SKILL_DIR/scripts/cli.js" resume   $MANIFEST <specId-or-testId> <answer.json>
node "$SKILL_DIR/scripts/cli.js" validate $MANIFEST
node "$SKILL_DIR/scripts/cli.js" metrics  $MANIFEST
```

`next` 回傳 `produce`、`test`、`clarify`、`done` 或 `halt`。`kind:"review"` 的 clarify 是 human gate；`kind:"environment"` 的目標是 test，其餘 clarify 的目標是 spec。

`next-all` 回 `batch.actions` 時，同批 action 在 `depends_on` 上互相獨立，應平行委派、等全部完成後序列記回。用 `--limit N` 對齊 host 可用 agent slots；回傳 `total_ready` 可看尚有多少 ready actions。停點／完成 action 與 `next` 相同，且 `actions[0]` 與 `next` 相容。

每個 action 的 `brief` 是機械派工輸入：角色、上游 outputs、gate outputs、失敗脈絡、ownership、review depth 與 env。不要重讀 manifest 自行組裝；需求語意仍來自 requirement 與該任務的 intake 切片。

`produce` / `test` 的輸出會內嵌 `next` 與 `continue`；只有實際出現在 response 的 action 才寫 lease 並計入 metrics。`continue:true` 同回合續跑，否則依停點處理。詳細 result schema 見 [action-protocol.md](action-protocol.md)。
