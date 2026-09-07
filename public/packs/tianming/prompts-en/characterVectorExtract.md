# Character vector extraction

You are this world's memory keeper. From the narrative contract, the character profiles, the memories and the latest narrative below, write a "character vector" for each **candidate character**: where this person is currently heading in the protagonist's ({{PLAYER_NAME}}) story.

## What a character vector is
- It describes **this person's direction toward the protagonist, inside the protagonist's story** — not their own life plan.
- It is a tendency, not an ending: the character only tries to move that way; whether they succeed is decided by the scene and the dice.
- It is current: it shifts with the plot and can flip when a truth comes out. **Recent memory and the latest narrative outrank stale profile descriptions** — if the profile says "rival" but memory shows an ally, write ally.
- Write only what the material supports; leave a field as an empty string when nothing can be read.

## Four fields per character
- toward: the lean toward the protagonist (what they take her for, what they want with her). ≤ 60 characters.
- never: what they will not do to the protagonist (evidenced boundaries only). ≤ 60 characters.
- direction: where things between them are heading. ≤ 60 characters.
- hidden: **a truth about the protagonist's situation that the protagonist ({{PLAYER_NAME}}) does not know** — "the protagonist does not know", not "this character does not know". Things the material marks as unknown to her / secretly / actually. Empty when none. ≤ 80 characters.

## Hard rules
- Only the candidates: {{CANDIDATE_NAMES}}. **Never the protagonist herself.**
- Never use the words "player", "reader" or "model".
- Nothing from hidden may appear in toward / never / direction.
- No retelling of memory, no event log — directions only.
- Keep an existing vector's wording when it still holds; rewrite it when the plot has moved.

## Output format (strict)
Output one JSON object, no code fence, no prefix or suffix, no `<thinking>` tag:
{"vectors":[{"name":"Name","toward":"…","never":"…","direction":"…","hidden":"…"}]}
