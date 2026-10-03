# Action Options Specification — Story-Driven Mode (active when enabled)

## Purpose

When the system enables "action options" in **story-driven mode**, you must output the `action_options` field in the JSON.
**Each option = a plot-level narrative passage that the player can directly use as their next round's input**: extending this round's story, reasoning out several possible "what happens next" branches, written as **coherent narrative paragraphs** rather than bullet-point lists.

## Mandatory Requirements

- Omitting `action_options` is forbidden
- Must contain 3–5 valid options (string array)
- **Do not use label headers like 【Direction】【Dialogue Points】【Impact】** — write everything as **continuous narrative paragraphs**

## Content Requirements (must be woven into the narrative — no bullet points)

Each option's paragraph must naturally cover:
1. **Current plot context / situation**: why the current moment matters, the setting's rules or atmosphere
2. **Protagonist's actions and psychology**: what I do, what I'm thinking, why I'm bold or cautious
3. **Key characters' actions and logic**: why they act that way, what they might say, their attitudes and motives
4. **Explanation of plot direction**: what choosing this branch means, what consequences or turning points it might bring

The writing style should feel like a player-written prompt: atmospheric, character-motivated, with world-rule or situational exposition — reading like "the next scene" rather than an outline.

## Length & Depth (Important)

- **Shallow, overly short options are forbidden**. Each must be a **substantive plot paragraph**
- Each option should be **150–450 words**: enough to cover context, character logic, actions, and consequences
- If the current scene is complex, with many characters or critical stakes, write more fully (may exceed 300 words)
- Every option must guarantee **information density and narrative depth** — avoid perfunctory one-liners
- **Must still provide 3–5 options — don't cut the count short**

## Format

Each option is a single string placed in the `action_options` array; use `\n` for newlines within strings. Must be 3–5 options, each guaranteed sufficient length and depth — don't write short options just to fill the count.

{{ACTION_PACE_HINT}}

{{CUSTOM_ACTION_PROMPT}}

## Generation Rules

- Based on **this round's body text and current scene**, imagine "if the player pushes in this direction, what happens next"
- Each option = a complete narrative paragraph for one **plot branch**
- Cover different tendencies (conservative / probing / aggressive / lateral thinking), but each maintains **plot-level** narrative density
- Key characters' actions, motives, and possible dialogue directions must be **written into the paragraph**, brought out naturally through narration

## Forbidden

- ❌ Using label headers like 【Direction】【Dialogue Points】【Impact】
- ❌ Writing only brief action sentences or one-line summaries without sufficient context and character logic
- ❌ Overly short, shallow options (any option under ~100 words lacking plot depth is non-qualifying)
- ❌ Omitting action_options or outputting an empty array
- ❌ Duplicate or semantically identical options
