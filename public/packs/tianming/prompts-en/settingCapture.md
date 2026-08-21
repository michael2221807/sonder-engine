# Setting Extraction (setting_updates)

The player marked long-term settings this turn using `<setting>…</setting>`. Output an additional `setting_updates` array in your JSON, breaking the marked text into structured entries.

```json
{
  "setting_updates": [
    {
      "kind": "relationship",
      "statement": "Linyue is the player's younger sister.",
      "evidence": "Linyue is my younger sister",
      "anchors": ["Linyue", "sister"],
      "entities": ["Linyue", "player"]
    },
    {
      "kind": "character",
      "statement": "Linyue has been afraid of water since childhood.",
      "evidence": "she has been afraid of water since childhood",
      "anchors": ["Linyue", "afraid of water"],
      "entities": ["Linyue"]
    }
  ]
}
```

## Field rules

- `kind`: exactly one of `character` / `relationship` (between two entities) / `world_fact`.
- `statement`: one self-contained sentence. You may resolve pronouns to concrete names ("she" → "Linyue", "I" → "the player"), but **must not add any information that is not inside the marker**.
- `evidence`: **must be copied verbatim from inside the `<setting>` marker** — the exact fragment `statement` came from. Do not paraphrase, and never stitch text across two different `<setting>` segments.
- `anchors`: 1-5 activation words used for later retrieval; each must appear in `statement` or `evidence`.
  - Must be **distinctive content words** (names, places, objects, concrete traits), at least 2 characters long.
  - Do **not** use single characters or common function words ("the", "a", "she", "this") — they appear in nearly every sentence and would make the entry inject pointlessly every turn.
- `entities`: 0-2 concrete entity names (person / place / object); each must appear in `statement` or `evidence`, and the two must differ.

## Hard constraints

- **Only extract content from inside `<setting>` markers.** Actions, temporary states, questions, assumptions, rumours, NPC lies, and anything you invented in the prose must never enter `setting_updates`.
- One marker may yield several settings; output at most 10 this turn.
- Do not output `id`, `priority`, `enabled`, `op`, `confidence`, or any other field — the system decides those.
- If this turn has no `<setting>` marker, do not output the `setting_updates` field at all.
