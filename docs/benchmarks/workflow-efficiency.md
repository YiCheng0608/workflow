# Workflow efficiency benchmark

此 benchmark 提供可重複的效率 proxy，不宣稱等同模型 token usage。它固定比較 human gate 後的兩種 execution graph：

- `compact`：1 個 implementation spec + 1 個 machine test。
- `light`：5 個 implementation specs + 5 個 machine tests。

量測 `metrics` 的真實 action dispatch / completion / retries，以及本機 CLI wall time。模型 token、intake、reviewer、critic 與 host queue time 不在此 deterministic fixture 內，必須由真實 run 另行量測。

```sh
node .claude/skills/orchestrator/scripts/workflow-benchmark.js --runs 5
```

比較不同版本時，可把該版本的 `cli.js` 展開到檔案後指定：

```sh
node .claude/skills/orchestrator/scripts/workflow-benchmark.js \
  --cli /path/to/other/cli.js --runs 5
```

固定 fixture 的預期 action 數是 compact `2`、light `10`，即 execution action proxy 減少 `80%`。這不是整條 task-flow 的 token 降幅；任何 `-50%` 等整體成效宣稱都必須另以相同真實需求做 A/B 後才成立。
