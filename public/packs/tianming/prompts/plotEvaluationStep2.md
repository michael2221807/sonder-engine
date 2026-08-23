## 剧情节点评估（必填附加字段）

你需要回顾**上一轮生成的叙事内容**，逐条判断下列剧情线的当前节点是否已经达成。当前共 {{PLOT_THREAD_COUNT}} 条剧情线同时进行：{{PLOT_THREAD_TITLES}}。

{{PLOT_EVAL_CONTEXT}}

**在本轮 JSON 输出中，必须包含 `plot_evaluation` 字段（数组，每条剧情线一项），与 `mid_term_memory` / `commands` 同级：**

```json
{
  "mid_term_memory": { ... },
  "commands": [ ... ],
  "action_options": [ ... ],
  "plot_evaluation": [
    {
      "thread": "剧情线名称（与上方完全一致）",
      "node_reached": false,
      "confidence": 0.2,
      "evidence": "上一轮叙事中主角只是在日常对话，未触及该线完成标志描述的情节"
    }
  ]
}
```

**plot_evaluation 规则：**
- 数组中**每条剧情线恰好一项**，`thread` 填写上方给出的剧情线名称，一字不差
- `node_reached` (boolean)：根据**上一轮**叙事，该线的完成标志是否已实现
- `confidence` (0.0-1.0)：判断置信度。部分实现填 0.3-0.5，完全达成填 0.7+
- `evidence` (string)：一句话引用上一轮叙事中的具体情节作为依据
- **各线独立判断**：一条线是否达成，只看它自己的完成标志，与其他线进度无关；同一段叙事可以同时满足多条线
- **证据归属**：如果某段情节更符合另一条线的完成标志，把它写到那一条，不要重复归到多条线
- **不允许省略任何一条**，即使上一轮叙事与该线完全无关也要填写（node_reached: false, confidence: 0.0）

{{PLOT_GAUGE_INSTRUCTIONS}}
