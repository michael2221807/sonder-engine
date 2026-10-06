# Split Generation 2/2: Commands Only

## Output Format (must be strictly followed)

Output only a single JSON object — no prefix or suffix text, no ` ``` ` code blocks:

```
{"mid_term_memory":{"相关角色":["Li Mingyang"],"事件时间":"1-01-15-08-30","记忆主体":"50-100 characters"},"commands":[{"action":"add","path":"世界.时间.分钟","value":30}],"action_options":["Option 1","Option 2","Option 3","Option 4","Option 5"],"knowledge_facts":[{"fact":"...","source_entity":"...","target_entity":"..."}]}
```

---

## mid_term_memory Structure (required, object format)

- **相关角色**: String array of character names involved this round (include "Player" if the player participated), e.g. `["Player","Li Mingyang"]`
- **事件时间**: Sortable string in game-time format, e.g. `"1-01-15-08-30"` (year-month-day-hour-minute)
- **记忆主体**: 50-100 characters, format: "plot summary + event impact + (importance weight in parentheses)"

---

## JSON & Path Rules (Important)

- Output only a single JSON object — no prefix or suffix text
- Use `\n` for newlines in strings
- `[NPCName]` in rule text is only a placeholder — when outputting paths, **you must replace it with the actual name** and do not keep brackets
- Brackets `[]` are only allowed in array index expressions: e.g. `角色.效果[0]`, `社交.关系[名称=Li Mingyang]`

---

## This Step Must Output

- `mid_term_memory`: Required, object format (as above)
- `commands`: Game state update command array
- `action_options`: 3-5 action options (string array)
- `knowledge_facts` (recommended): This round's important facts

---

## NPC Operation Standards

**Push is for brand-new characters ONLY (hard constraint)**: Before any push, check the NPC rosters already in context (present/absent lists, the game state JSON, and NPCs already created earlier in this conversation). Any character that already exists — including those created in opening step 1 and those currently absent — must NEVER be pushed again; use the `set` / `add` commands under "Updating NPC fields" below instead.

**Creating a new NPC** (must push a complete object in one go, with `类型` field):
```json
{"action": "push", "path": "社交.关系", "value": {
  "名称": "Li Mingyang",
  "性别": "男",
  "年龄": 35,
  "出生日期": {"年": -10, "月": 3, "日": 12},
  "类型": "重点",
  "好感度": 50,
  "位置": "Qingyun Town·Teahouse",
  "描述": "Brief appearance summary",
  "性格特征": ["Composed", "Suspicious"],
  "关系状态": "Stranger",
  "记忆": [],
  "在做事项": "Gathering information at the teahouse"
}}
```

[私密]
> Note: When `系统.nsfwMode=true` and the NPC's gender matches `系统.nsfwGenderFilter`, the NPC value above **must** also include a `私密信息` field (full field structure below).
[/私密]

[私密]
**NPC Private Information (when `系统.nsfwMode=true`)**:

When `系统.nsfwMode=true` and the NPC's gender matches `系统.nsfwGenderFilter`, the pushed NPC value **must** include a complete `私密信息` object (placeholders like "TBD" / "N/A" / empty objects are forbidden):

```json
"私密信息": {
  "是否为处女/处男": true,
  "身体部位": [{"部位名称":"...", "敏感度":60, "开发度":0, "特征描述":"...", "特殊印记":""}],
  "性格倾向": "...",
  "性取向": "...",
  "性癖好": ["..."],
  "性渴望程度": 30,
  "当前性状态": "...",
  "体液分泌状态": "...",
  "性交总次数": 0,
  "性伴侣名单": [],
  "最近一次性行为时间": "None",
  "特殊体质": []
}
```

Logical consistency: `是否为处女/处男=true` → `性交总次数=0`, `性伴侣名单=[]`. If an NPC already exists but lacks private info, use `set 社交.关系[名称=NPCName].私密信息` to fill it in.
[/私密]

**Updating NPC fields**:
```json
{"action": "add", "path": "社交.关系[名称=Li Mingyang].好感度", "value": 10}
{"action": "set", "path": "社交.关系[名称=Li Mingyang].在做事项", "value": "Heading toward the city gate"}
{"action": "set", "path": "社交.关系[名称=Li Mingyang].位置", "value": "Huajing·Dewei Noble High School·Front Gate"}
{"action": "set", "path": "社交.关系[名称=Li Mingyang].是否在场", "value": true}
{"action": "push", "path": "社交.关系[名称=Li Mingyang].记忆", "value": "Met the player at the teahouse; quite intrigued by them"}
```

**NPC Location Sync (hard constraint)**:
- Every NPC appearing in this round's narrative **must** have their `位置` set to their current location (using full `·`-separated path)
- When an NPC follows the player to a new location, their `位置` must update to the player's new position
- When an NPC leaves the scene, `位置` updates to their destination and `set 是否在场 = false`
- This is as important as `角色.基础信息.当前位置` — **missing location data causes the UI to fail to display the NPC's whereabouts**

**NPC-to-NPC relationships** (via commands only):
```json
{"action": "set", "path": "社交.关系[名称=Zhang San].关系.Li Si", "value": "Master-disciple"}
```

**Real-time tracked NPCs**: If any NPC field in the save data is flagged for real-time tracking, even if that NPC is not near the player, you must project their dynamics based on this round's plot and update their location/status/current activity.

---

## Location & Exploration (mandatory)

- When `角色.基础信息.当前位置` changes, you must also `push 世界.地点信息`
- Multi-level locations must generate all parent levels in sequence (see core Section VI)
- Locations must be real places only — vehicles/states/generic references are forbidden (see core Section VI)
- Pushed locations must include `描述`

---

## knowledge_facts Structure (recommended)

```json
{
  "knowledge_facts": [
    {"fact": "Zhang San is a direct disciple of the Heavenly Sword Sect, studying under Sect Master Qingyun Zi", "source_entity": "Zhang San", "target_entity": "Heavenly Sword Sect"},
    {"fact": "The player obtained a Qingfeng Sword at Mount Qingcheng", "source_entity": "Player", "target_entity": "Qingfeng Sword"},
    {"fact": "Li Si harbors deep hatred toward the player, as the player killed his father", "source_entity": "Li Si", "target_entity": "Player"}
  ]
}
```

- `fact`: Complete natural language sentence (15-40 words), preserving all specific details
- `source_entity / target_entity`: Must be person names, place names, or organization names
- Only extract facts that **involve two entities and have implications for future plot**
- Character inner feelings and solo actions do not produce facts

---

## Forbidden (violations will cause generation failure)

- ❌ `text` field (body text was completed in Step 1 — do not regenerate)
- ❌ `<thinking>` tags
- ❌ Content outside JSON
- ❌ Any narrative/body text content

---

## Final Emphasis

Output only: `{"mid_term_memory":{...},"commands":[...],"action_options":[...],"knowledge_facts":[...]}`
Do not output a text field!
