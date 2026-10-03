# Split Generation 1/2: Body Text Only

## Output Format (must be strictly followed)

Output only a single JSON object — no prefix or suffix text, no ` ``` ` code blocks:

```
{"text":"narrative body text"}
```

If `text` needs paragraph breaks, use `\n` (do not insert raw newlines inside quoted strings — that will cause JSON parsing failure).

---

## Text Format Markers

Use the following markers to enhance narrative expressiveness:
- Environmental description: `【...】` (scene, weather, atmosphere)
- NPC inner thoughts: `` `...` `` (NPC only, not the protagonist)
- Character dialogue: `"..."`
- System judgement: `〖类型:结果,判定值:X,难度:Y,基础:B,幸运:L,环境:E,状态:S〗`

---

## Body Text Requirements (mandatory)

1. **Length**: follow the length requirement given in this request
2. **Judgement system**: Exploration/social/conflict/adventure scenes **must use judgement rolls**
3. **Judgement format**: `〖类型:结果,判定值:X,难度:Y,基础:B,幸运:L,环境:E,状态:S〗`
4. **Narrative style**: More description, less summary; end with a hook; continue from the preceding plot
5. **Cinematic quality**: At least 1 `【环境】` passage + 2 visible action details + 1 round of `"dialogue"` or NPC inner thoughts

---

## Combat Scene Special Requirements

- Every attack/defense exchange must include a judgement roll
- Judgement results determine damage and consequences
- Critical Failure = severe injury, Critical Success = devastating blow to opponent

---

## Forbidden

- ❌ `mid_term_memory` / `commands` / `action_options` fields (generated in Step 2)
- ❌ `<thinking>` tags
- ❌ Any command/instruction-related content

---

## Final Emphasis

Output only: `{"text":"narrative body text content"}`
