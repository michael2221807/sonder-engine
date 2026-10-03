# Main Round Context

## Current Game State

```json
{{GAME_STATE_JSON}}
```

{{ENVIRONMENT_BLOCK}}

## Memory Summary

{{MEMORY_BLOCK}}

{{BOOKMARKED_ROUNDS_BLOCK}}

---

The player's input will be sent as the **last user message** (appended by the pipeline after the chat history, prefixed with `narratorEnforcement`). Output this round's narrative and state changes in the JSON format defined by the core module.

## This Round's Requirements

### Judgement Rolls
- Reference the six core attributes to determine action success or failure (体质/直觉/悟性/气运/魅力/心性)
- Conflicts, exploration, social maneuvering, and other critical actions **must use judgement rolls**, format: `〖类型:结果,判定值:X,难度:Y,基础:B,幸运:L,环境:E,状态:S〗`

### Time
- Actions that consume time must `add 世界.时间.分钟 (World > Time > Minutes)` (typically 10-60 minutes per round)
- Major time skips must be explicitly described in the narrative

### Location
- Moving to a new location requires both `set 角色.基础信息.当前位置 (Character > Basic Info > Current Location)` and `push 世界.地点信息 (World > Location Info)`
- Multi-level locations must generate all parent levels (see core module Section 6)

### Stamina / Energy
- Stamina and energy consumption use `add 角色.可变属性.体力.当前 (Character > Mutable Attributes > Stamina > Current)` (negative value) and `add 角色.可变属性.精力.当前 (Character > Mutable Attributes > Energy > Current)` (negative value)

### Environment / Weather / Festival (Mandatory Sync -- Iron Law, see core Section 4.5)
- Every round's commands must include these 3 set commands (even if the values haven't changed):
  - `set 世界.天气` → current weather name string (default `"晴"`)
  - `set 世界.节日` → `{名称, 描述, 效果}` object (default `{名称:"平日",描述:"",效果:""}`)
  - `set 世界.环境` → complete array of all active tags (default `[]`; max 3 entries)
- The judgement roll's `环境:E` modifier must be traceable to the current `世界.环境[*].效果` field (or the festival's effect); writing a nonzero value without a source is non-compliant
- See core module Section 4.5 for detailed field formats and trigger rules

### Action Options
- `action_options` must output 3-5 options; it cannot be omitted or an empty array
- Each option is an action description starting with a verb, 8-20 characters long
- Coverage: conservative (observe/wait), neutral (converse/learn), proactive (explore/act), special (a unique choice based on the current situation)

### Mid-Term Memory (Required Every Round)
- `mid_term_memory` **must be output every round**, **null is not allowed**, **omission is not allowed**
- This is the 1:1 pairing invariant of the memory system: every short-term narrative entry must have a corresponding structured memory summary
- For ordinary rounds, write approximately 50 characters; for important events, write up to 100 characters with an importance weight of 1-10 in parentheses
- If there is no plot progression this round (pure waiting/description/monologue), still write one entry recording the current state and location

**mid_term_memory object format** (required every round):
```json
{
  "相关角色": ["Player", "NPC Name"],
  "事件时间": "Year-Month-Day-Hour-Minute (e.g. 1-01-15-08-30)",
  "记忆主体": "50-100 chars: plot summary + event impact + (importance weight 1-10 in parentheses, optional)"
}
```

### Knowledge Facts (Recommended)

`knowledge_facts` records **important factual relationships between two entities** that emerge this round. The system will automatically perform semantic search and inject relevant facts into the AI context in subsequent rounds.

```json
{
  "knowledge_facts": [
    {"fact": "Zhang San is a direct disciple of the Tianjian Sect, apprenticed under Sect Leader Qingyunzi", "source_entity": "Zhang San", "target_entity": "Tianjian Sect"},
    {"fact": "The player obtained the Qingfeng Sword in an ancient cave on Mount Qingcheng", "source_entity": "Player", "target_entity": "Qingfeng Sword"}
  ]
}
```

**fact** must be a complete natural-language sentence (15-40 characters), preserving all specific details (names, locations, reasons).
**source_entity / target_entity** must be specific person names, place names, or organization names -- not descriptive phrases.

Only extract facts that **involve two entities and impact subsequent plot development**, 3-8 entries per round. A character's inner feelings or solitary actions do not produce facts.
See core module Section 14 for the full specification.

### Real-Time Tracked NPCs

If any NPC field in the save data is flagged for real-time tracking, even if that NPC is not near the player, you must project their dynamics based on this round's plot and update their location/status/current activity.

---

## Output Format

```json
{
  "text": "This round's narrative ({{wordCount}}+ characters)",
  "mid_term_memory": {
    "相关角色": ["Player"],
    "事件时间": "1-01-15-08-30",
    "记忆主体": "Approx. 50-char summary of this round; null is not allowed"
  },
  "commands": [...],
  "action_options": ["Option 1", "Option 2", "Option 3", "Option 4"],
  "knowledge_facts": [{"fact": "...", "source_entity": "...", "target_entity": "..."}]
}
```
