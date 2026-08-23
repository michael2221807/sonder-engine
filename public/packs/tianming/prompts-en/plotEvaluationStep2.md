## Plot Node Evaluation (Required Additional Field)

Review **the previous round's generated narrative** and judge, thread by thread, whether each plot thread's current node has been reached. {{PLOT_THREAD_COUNT}} thread(s) are running in parallel: {{PLOT_THREAD_TITLES}}.

{{PLOT_EVAL_CONTEXT}}

**In this round's JSON output you must include a `plot_evaluation` field (an array with exactly one item per thread), at the same level as `mid_term_memory` / `commands`:**

```json
{
  "mid_term_memory": { ... },
  "commands": [ ... ],
  "action_options": [ ... ],
  "plot_evaluation": [
    {
      "thread": "thread title (exactly as listed above)",
      "node_reached": false,
      "confidence": 0.2,
      "evidence": "In the previous round the protagonist was only making small talk — nothing matching this thread's completion criteria happened"
    }
  ]
}
```

**plot_evaluation rules:**
- **Exactly one item per thread**; `thread` must match the thread title above character for character
- `node_reached` (boolean): based on **the previous round's** narrative, has this thread's completion criteria been fulfilled
- `confidence` (0.0-1.0): judgment confidence. Partial fulfillment: 0.3-0.5; full fulfillment: 0.7+
- `evidence` (string): one sentence citing the specific moment in the previous round's narrative
- **Judge each thread independently**: whether a thread is reached depends only on its own completion criteria, never on another thread's progress; one scene may satisfy several threads at once
- **Attribute evidence correctly**: if a moment fits another thread's criteria better, report it under that thread — do not count it for more than one
- **Never omit a thread** — even if the previous round had nothing to do with it, report it (node_reached: false, confidence: 0.0)

{{PLOT_GAUGE_INSTRUCTIONS}}
