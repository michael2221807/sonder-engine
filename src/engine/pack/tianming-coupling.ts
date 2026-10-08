/**
 * Register of the places where engine code still knows the content of the Tianming pack.
 *
 * What this file is: a REGISTER of known pack coupling, not an engine contract. Each constant below is a field
 * name, a part name, a value or a legacy alias that the engine reads but the pack, not the engine, owns. They are
 * collected here so the coupling is visible in one place and a later move into pack rule JSON changes this file
 * only (engine-principles §4 debt; refactor R4).
 *
 * Every constant has the exact value the literal had where it was used. Names carry the `TIANMING_` prefix on
 * purpose: do not use one as if it were a neutral engine concept, and do not "unify" two constants that look alike
 * — several differ in value on purpose (see the notes on each one).
 *
 * Runtime leaf: this module must not import anything.
 */

// ─── NSFW privacy contract (validators/privacy-profile-validator.ts, audit E01-007) ───

/** The 8 fields every NPC `私密信息` object must hold (middle strictness). */
export const TIANMING_PRIVACY_REQUIRED_FIELDS = [
  '是否为处女/处男',
  '身体部位',
  '性格倾向',
  '性取向',
  '性癖好',
  '性渴望程度',
  '性交总次数',
  '性伴侣名单',
] as const;

/** The partner-list field: an empty array is legal there (virgin state). */
export const TIANMING_PRIVACY_PARTNER_LIST_FIELD = '性伴侣名单';

/** The body-parts array field of `私密信息` and the keys of one part entry. */
export const TIANMING_PRIVACY_BODY_PARTS = {
  field: '身体部位',
  nameKey: '部位名称',
  descriptionKey: '特征描述',
} as const;

/** The four parts that must always exist in the body-parts array (exact match). */
export const TIANMING_PRIVACY_REQUIRED_PART_NAMES = ['嘴', '胸部', '小穴', '屁穴'] as const;

/** The virgin flag; `false` makes the three first-night fields required. */
export const TIANMING_PRIVACY_VIRGIN_FIELD = '是否为处女/处男';

/** The three fields required when the NPC is not a virgin. */
export const TIANMING_PRIVACY_NON_VIRGIN_FIELDS = ['初夜夺取者', '初夜时间', '初夜描述'] as const;

/** The 5 fields the player's body object (`角色.身体`) must hold. */
export const TIANMING_PLAYER_BODY_REQUIRED_FIELDS = ['身高', '体重', '三围', '敏感点', '开发度'] as const;

/** Fields of the player body that have a shape check of their own, and the sub-keys of the three-size object. */
export const TIANMING_PLAYER_BODY_SHAPE = {
  sizes: '三围',
  sizeKeys: ['胸围', '腰围', '臀围'] as const,
  sensitivePoints: '敏感点',
  development: '开发度',
} as const;

/**
 * Words that count as "not filled in" (lower case, matched after trim + lower-casing).
 * NOT the same list as the placeholder set in `field-completeness-validator.ts`, which also holds the empty
 * string — the two are kept apart on purpose.
 */
export const TIANMING_PRIVACY_PLACEHOLDERS = [
  '待生成', '待ai生成', '暂无', '无', '未知', '未定义', 'tbd', 'todo', 'placeholder',
] as const;

/** Gender values the NSFW gender filter matches (besides the English `female` / `male`). */
export const TIANMING_GENDER_VALUES = {
  female: '女',
  male: '男',
} as const;

// ─── Image archive keys (object under `角色.图片档案` and `社交.关系[].图片档案`) ───

export const TIANMING_IMAGE_ARCHIVE_KEYS = {
  /** NSFW part images. */
  secretChamber: '香闺秘档',
  /** Generation history. */
  generationHistory: '生图历史',
  /** Id of the chosen avatar image. */
  selectedAvatarId: '已选头像图片ID',
} as const;

// ─── Card export (export/card-export-paths.ts, audit E10-009) ───

/** Variable-attribute sub-fields reset to full when a card is exported. */
export const TIANMING_VITAL_FIELDS = {
  current: '当前',
  cap: '上限',
} as const;

/**
 * Which character fields a template-mode card may expose for player editing; paths are relative to the character
 * root. Arrays are copied by the policy builder, so every call returns fresh arrays as before.
 */
export const TIANMING_PROTAGONIST_EDITABLE = {
  whitelist: ['基础信息.姓名', '基础信息.年龄', '基础信息.性别', '基础信息.特质', '基础信息.外貌', '背包'],
  blacklist: ['属性', '可变属性', '效果', '图片档案', '身体'],
  gray: ['身份.先天六维', '身份.出身', '身份.天赋'],
} as const;

// ─── Memory entries ───

/** Key a short-term memory entry may carry its text under (read next to the English `content`). */
export const TIANMING_MEMORY_ENTRY_CONTENT_KEY = '内容';

// ─── Legacy / divergent NPC keys ───

/**
 * NPC keys that look like an `npcFieldNames` entry but have a DIFFERENT value. Do not replace them with the
 * `npcFieldNames` entry: that changes behavior (known issues E03-007 / E12-003 keep the divergence).
 *  - `relationToPlayer`: older name of `npcFieldNames.relationshipStatus` ('关系状态').
 *  - `appearanceAlias`: `npcFieldNames.appearance` is '外貌描述'; the auto-portrait reads '外貌描写'.
 *  - `locationAlias`: `npcFieldNames.location` is '位置'; NPC generation reads '当前位置'.
 */
export const TIANMING_LEGACY_NPC_KEYS = {
  relationToPlayer: '与玩家关系',
  appearanceAlias: '外貌描写',
  locationAlias: '当前位置',
} as const;

/** Location key location-dedup reads for the NPC list; `locationFieldNames.npcList` is an array, this is not. */
export const TIANMING_LOCATION_NPC_KEY = 'NPC';

// ─── Secret-part names (image subsystem, audit E07a-010 / E07b-011) ───

/**
 * Chinese part name for each engine `SecretPartType`. It is both the `部位名称` of a `私密信息.身体部位` entry and the
 * key of a part under `图片档案.香闺秘档`. Callers keep their own semantics for an unknown value: the ternary form
 * (`p === 'breast' ? .breast : p === 'vagina' ? .vagina : .anus`) falls through to `anus`, a table lookup
 * (`PART_TO_CN[part]`) yields undefined. Do not collapse the two.
 */
export const TIANMING_SECRET_PART_CN = {
  breast: '胸部',
  vagina: '小穴',
  anus: '屁穴',
} as const;
