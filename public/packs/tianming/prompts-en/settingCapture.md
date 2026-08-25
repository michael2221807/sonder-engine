# Setting Extraction (setting_updates)

The player marked long-term settings this turn using `<setting>…</setting>`. Output an additional `setting_updates` array in your JSON — **digest the marked text fully and decompose it** into structured entries.

## Method (mandatory)

The marked content **may be any length** — one sentence or an entire essay. Your job:

1. **Read it through first**: how many independent setting facts does it contain? (One fact = one assertion about a character / relationship / the world that is worth remembering long-term.)
2. **Output one `setting_update` per fact**: a one-sentence summary of that fact, plus a short source snippet.
3. A long passage usually holds 3–8 facts; **always prefer several short entries over one long one**. Drop rhetoric, examples, and tone — keep the core assertions that would change future story turns.

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
- `statement`: one self-contained sentence, **at most 200 characters** (anything over 240 is rejected outright). A long marked passage MUST be split into several entries, one claim each. You may resolve pronouns to concrete names ("she" → "Linyue", "I" → "the player"), but **must not add any information that is not inside the marker**.
- `evidence`: **must be copied verbatim from inside the `<setting>` marker** — the exact fragment `statement` came from. Keep it to a **short locating snippet** (10–60 characters is ideal, **stay under 150**; over 180 is rejected). Do not copy whole paragraphs, do not paraphrase, and never stitch text across two different `<setting>` segments.
- `anchors`: 1-5 activation words used for later retrieval; each must appear in `statement` or `evidence`.
  - Must be **distinctive content words** (names, places, objects, concrete traits), at least 2 characters long.
  - Do **not** use single characters or common function words ("the", "a", "she", "this") — they appear in nearly every sentence and would make the entry inject pointlessly every turn.
- `entities`: 0-2 concrete entity names (person / place / object); each must appear in `statement` or `evidence`, and the two must differ.

## Long-passage example

Marked input (excerpt):

> `<setting>`This world runs the "Livestock Ordinance": registered women of age are assigned service duties by rating, with generous pay and education/employment privileges; men shoulder heavier labour in exchange for lawful access. Society as a whole has accepted the rules — opposition survives only as squabbles over details.`</setting>`

Correct output (one passage → several entries, one fact each + short source):

```json
{
  "setting_updates": [
    { "kind": "world_fact", "statement": "This world runs the Livestock Ordinance: registered women of age are assigned service duties by rating.", "evidence": "registered women of age are assigned service duties by rating", "anchors": ["Livestock Ordinance", "rating"], "entities": [] },
    { "kind": "world_fact", "statement": "Women in service receive generous pay plus education and employment privileges.", "evidence": "generous pay and education/employment privileges", "anchors": ["pay", "privileges"], "entities": [] },
    { "kind": "world_fact", "statement": "Men shoulder heavier labour in exchange for lawful access.", "evidence": "men shoulder heavier labour in exchange for lawful access", "anchors": ["men", "labour"], "entities": [] },
    { "kind": "world_fact", "statement": "Society accepts the Ordinance; opposition survives only as squabbles over details.", "evidence": "opposition survives only as squabbles over details", "anchors": ["Ordinance", "opposition"], "entities": [] }
  ]
}
```

Wrong (rejected wholesale): stuffing the whole passage into one statement, or copying whole paragraphs as evidence.

## Hard constraints

- **Only extract content from inside `<setting>` markers.** Actions, temporary states, questions, assumptions, rumours, NPC lies, and anything you invented in the prose must never enter `setting_updates`.
- One marker may yield several settings; output at most 10 this turn.
- Do not output `id`, `priority`, `enabled`, `op`, `confidence`, or any other field — the system decides those.
- If this turn has no `<setting>` marker, do not output the `setting_updates` field at all.
