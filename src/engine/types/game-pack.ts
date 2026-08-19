/**
 * Game Pack 类型定义
 *
 * Game Pack 是纯数据包（JSON/Markdown），不含代码。
 * 引擎通过 GamePackLoader 加载 manifest.json，
 * 然后根据 manifest 声明递归加载所有资源文件。
 *
 * 对应 STEP-02 §4 Game Pack 规范。
 */

/**
 * Game Pack manifest — 对应 manifest.json
 * 声明包的元数据和所有资源文件路径
 */
export interface GamePackManifest {
  /** 包唯一标识（如 "tianming"） */
  id: string;
  /** 显示名称 */
  name: string;
  /** 语义化版本号 */
  version: string;
  /** 引擎最低版本要求 */
  engineVersion: string;
  /** 描述文字 */
  description?: string;
  /** 作者 */
  author?: string;

  /** 状态树 schema 文件路径（如 "schemas/state-schema.json"） */
  entrySchema: string;
  /** 创角流程配置文件路径 */
  creationFlow: string;

  /** prompt flow 配置文件路径映射（key=flowId, value=文件路径） */
  promptFlows: Record<string, string>;
  /** prompt 模块 ID 列表（对应 prompts/{id}.md 文件） */
  prompts: string[];
  /** 预设数据文件路径映射（key=预设类型, value=文件路径） */
  presets: Record<string, string>;
  /** 规则配置文件路径映射（key=规则类型, value=文件路径） */
  rules: Record<string, string>;
  /** Locale-specific prompt directories (key=locale, value=directory prefix e.g. "prompts-en") */
  promptLocales?: Record<string, string>;
  /** Locale-specific i18n files (key=locale, value=relative path e.g. "i18n/en.json") */
  i18nFiles?: Record<string, string>;
}

/**
 * 加载后的完整 Game Pack
 * 由 GamePackLoader 解析 manifest 并加载所有资源后生成
 */
export interface GamePack {
  /** 原始 manifest */
  manifest: GamePackManifest;
  /** 状态树 JSON Schema（用于校验和 UI 渲染） */
  stateSchema: Record<string, unknown>;
  /** 创角流程配置 */
  creationFlow: CreationFlowConfig;
  /** 预设数据（key=类型, value=条目数组） */
  presets: Record<string, unknown[]>;
  /** Prompt 内容（key=promptId, value=Markdown 文本） */
  prompts: Record<string, string>;
  /** Prompt Flow 配置（key=flowId, value=flow 定义） */
  promptFlows: Record<string, PromptFlowConfig>;
  /** 规则配置（key=规则类型, value=规则 JSON） */
  rules: Record<string, unknown>;
  /** 主题配置（可选） */
  theme?: Record<string, unknown>;
  /** 显示设置（可选） */
  displaySettings?: Record<string, unknown>;
  /** 国际化文案（可选，key=locale, value=键值对） */
  i18n?: Record<string, Record<string, string>>;
  /** Engine-level prompt fragments (extracted from context-assembly for i18n) */
  engineFragments?: Record<string, string>;
  /** Transformer preset defaults (image generation AI instructions, locale-aware) */
  transformerDefaults?: Record<string, unknown>;
}

// ─── 创角流程相关类型 ───

export type CreationGenre = 'modern' | 'wuxia' | 'fantasy' | 'dystopia';
export type CreationContentRating = 'general' | 'nsfw';
export type CreationGenreScope = CreationGenre | 'all';

/** Shared runtime shape for pack and user-authored preset entries. */
export interface PresetEntry {
  id?: string | number;
  name?: string;
  label?: string;
  description?: string;
  source?: 'pack' | 'user';
  [key: string]: unknown;
}

export interface WorldPresetEntry extends PresetEntry {
  id: string;
  name: string;
  description: string;
  genre: CreationGenre;
  contentRating: CreationContentRating;
}

export interface CreationChoicePresetEntry extends PresetEntry {
  id: string;
  name: string;
  description: string;
  genres: CreationGenreScope[];
  adultOnly: boolean;
  talent_cost: number;
  attribute_modifiers?: Record<string, number>;
}

/** 创角流程配置 — 定义创角的所有步骤 */
export interface CreationFlowConfig {
  steps: CreationStep[];
}

/** 单个创角步骤 */
export interface CreationStep {
  /** 步骤 ID（如 "world", "talentTier", "attributes"） */
  id: string;
  /** 步骤显示标签 */
  label: string;
  /** 步骤类型 — 决定渲染哪个步骤组件 */
  type: 'select-one' | 'select-many' | 'attribute-allocation' | 'form' | 'confirmation';
  /** 预设数据来源（如 "presets.worlds"），引用 manifest.presets 中的 key */
  dataSource?: string;
  /** 是否必选 */
  required?: boolean;
  /** 花费字段名（如 "talent_cost"） — 在预设条目中标记花费的字段 */
  costField?: string;
  /** 花费来源变量名（如 "pointBudget"） */
  costSource?: string;
  /** form 类型步骤的字段定义 */
  fields?: FormFieldConfig[];
  /** attribute-allocation 类型步骤的属性名列表 */
  attributes?: string[];
  /** 每个属性的最大值 */
  perAttributeMax?: number;
  /** 总分配点数 */
  totalPoints?: number;
  /** 属性描述映射（如 { "体质": "影响体力上限与耐久" }），用于在分配 UI 旁显示提示 */
  attributeDescriptions?: Record<string, string>;
  /** AI 生成配置（允许用户请求 AI 生成自定义预设条目） */
  aiGeneration?: {
    enabled: boolean;
    promptFlow: string;
    promptModule: string;
  };
  /**
   * 用户手填自定义预设的字段定义（2026-04-14 新增）
   *
   * 当 step 类型是 select-one / select-many 且 dataSource 引用了 presets.X 时，
   * 提供 customSchema 即可让 UI 显示"+ 自定义"按钮。点击后弹出 CustomPresetModal，
   * 渲染这些字段供用户填写。提交后由 CustomPresetStore 持久化到 IDB，
   * 之后在选择列表中与 pack 内置项混排显示，并打 `source: 'user'` 标签。
   *
   * 留空（不提供此字段）= 不允许该 step 自定义条目（与历史行为一致）。
   */
  customSchema?: CustomPresetSchema;
  /** 选择后影响的变量映射（如 { "pointBudget": "$.total_points" }） */
  affects?: Record<string, string>;
  /**
   * 详情面板字段配置（用于 PresetDetailPanel 右栏展示）
   * 不提供时，详情面板仅显示 description 字段。
   */
  detailFields?: DetailField[];
  /**
   * 2026-04-11 fix — 本步骤的选择/分配值在初始状态树中的落地路径。
   *
   * 之前版本 `character-init.ts.buildInitialState` 把 select-* 选择按 `state[stepId]`
   * 直接写到状态树根（`state.talents = [...]` 等），导致：
   *  1. 玩家选的天赋不出现在 `角色.身份.天赋` 中，GameVariablePanel 看不到
   *  2. 分配的六维写到 `角色.属性` 会被 AI 开场指令覆盖，且没有 `先天六维` 基线
   *
   * 新字段：
   *   - select-one / select-many：选中值写入 `statePath`（结合 `valueField`）
   *   - attribute-allocation：`statePath` 是父路径（如 `角色.身份.先天六维`），
   *                           每个属性以子路径写入
   *   - form：不使用（form 字段自己带 key 路径）
   *
   * 空字符串 / 未提供时回退到旧行为（dump 到 `state[stepId]`），保证向后兼容。
   */
  statePath?: string;
  /**
   * 2026-04-11 fix — 从选中的 preset 对象中提取哪一个字段作为写入值。
   *
   * 场景：select-one 选了一个完整的 preset `{ id, name, description, talent_cost }`，
   * 但 `角色.身份.出身` 期望一个字符串。`valueField: "name"` 表示提取 `preset.name`
   * 作为写入值。
   *
   * 规则：
   *   - select-one + 有 valueField：写入 `preset[valueField]`
   *   - select-one + 无 valueField：写入整个 preset 对象
   *   - select-many + 有 valueField：写入 preset.map(p => p[valueField])（字符串数组）
   *   - select-many + 无 valueField：写入整个 preset 数组
   *   - attribute-allocation：不使用
   */
  valueField?: string;
  /**
   * When set alongside valueField, extractStoredValue produces structured objects
   * instead of plain strings. The value is read from `preset[descriptionField]`.
   * Output keys default to valueField/descriptionField unless overridden by
   * outputNameKey/outputDescKey.
   */
  descriptionField?: string;
  /** Key name for the "name" field in the output object (e.g. "名称"). Defaults to valueField. */
  outputNameKey?: string;
  /** Key name for the "description" field in the output object (e.g. "描述"). Defaults to descriptionField. */
  outputDescKey?: string;
}

/** 详情面板中的单个展示字段 */
export interface DetailField {
  /** 显示标签 */
  label: string;
  /** 条目对象中的字段 key */
  key: string;
  /** 值类型，影响渲染方式 */
  type: 'text' | 'number' | 'array' | 'object-map';
  /** 自定义格式化函数（运行时注入，JSON 中不使用） */
  formatter?: (v: unknown) => string;
}

/**
 * 自定义预设字段 schema —— 决定 CustomPresetModal 渲染什么字段
 *
 * 与 `FormFieldConfig` 相似但语义不同：FormFieldConfig 用于"创角时填的角色信息"
 * 写入状态树；CustomPresetSchema 用于"用户向 preset 列表追加新条目"。
 *
 * 字段类型尽量复用 SchemaForm/SchemaField 已支持的几种基本类型（string/number/textarea），
 * 以便复用现有渲染逻辑。
 */
export interface CustomPresetSchema {
  fields: CustomPresetField[];
}

export interface CustomPresetField {
  /** 字段在 entry 对象中的 key（如 "name", "description", "talent_cost"） */
  key: string;
  /** UI 显示标签 */
  label: string;
  /** 输入类型 —— 简单几种，配合 native input/textarea 即可 */
  type: 'text' | 'textarea' | 'number' | 'select' | 'checkbox';
  /** 占位提示文本 */
  placeholder?: string;
  /** 是否必填（提交校验） */
  required?: boolean;
  /** number 类型：默认值 / 范围 */
  default?: string | number | boolean;
  min?: number;
  max?: number;
  /** select 类型：静态选项值。 */
  options?: string[];
  /** textarea 行数 */
  rows?: number;
}

/** form 类型步骤中的单个字段 */
export interface FormFieldConfig {
  /** 字段 key */
  key: string;
  /** 字段类型 */
  type: 'text' | 'number' | 'select' | 'textarea';
  /** 显示标签 */
  label?: string;
  /** 占位提示文本 */
  placeholder?: string;
  /** 是否必填 */
  required?: boolean;
  /** 默认值 */
  default?: unknown;
  /** select 类型的选项列表 */
  options?: string[];
  /** number 类型的最小值 */
  min?: number;
  /** number 类型的最大值 */
  max?: number;
}

// ─── Prompt Flow 相关类型 ───

/**
 * Prompt Flow 配置
 * 定义一个 prompt 组装流程中的模块列表和排序
 */
export interface PromptFlowConfig {
  /** Flow ID（如 "mainRound", "memorySummary"） */
  id: string;
  /** 参与组装的 prompt 模块列表 */
  modules: PromptFlowModule[];
}

/**
 * Prompt Flow 中的单个模块引用
 * 指定 prompt 内容、角色、顺序和注入深度
 */
export interface PromptFlowModule {
  /** 引用的 prompt ID（对应 prompts/{id}.md） */
  promptId: string;
  /** 消息角色 */
  role: 'system' | 'user' | 'assistant';
  /** 组装顺序（升序排列） */
  order: number;
  /**
   * 注入深度：
   * 0 = 放在聊天历史之前（系统消息区）
   * N = 从聊天历史末尾往前第 N 条之前插入
   */
  depth?: number;
  /** 条件变量名 — 该变量为 truthy 时才包含此模块 */
  condition?: string;
}
