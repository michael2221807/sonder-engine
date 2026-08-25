/**
 * Built-in prompt slot definitions.
 *
 * Each slot represents an overridable prompt component. World book entries
 * with a matching `builtinSlotId` will replace the default content.
 *
 * Mapped from the original 世界书本体槽位 — adapted to AGA's scope
 * (no battle, no fandom, no realm system).
 */

export interface BuiltinSlotDefinition {
  id: string;
  title: string;
  category: string;
  description: string;
  /** Default pack prompt file ID (from manifest.prompts) */
  defaultPromptId?: string;
}

/**
 * All overridable prompt slots.
 *
 * The key is used as the slot ID throughout the system.
 * World book entries reference these via `builtinSlotId`.
 */
export const BUILTIN_SLOTS: Record<string, BuiltinSlotDefinition> = {
  // ─── Core Identity ────────────────────────────────────────
  narrator_role: {
    id: 'narrator_role',
    title: 'AI 角色声明',
    category: '常驻',
    description: '定义 AI 的叙事者身份、职责和创作语境',
    defaultPromptId: 'narratorFrame',
  },
  narrator_enforcement: {
    id: 'narrator_enforcement',
    title: '执行强化',
    category: '常驻',
    description: '放在 chat history 之后的执行提醒（邻近位置约束力最强）',
    defaultPromptId: 'narratorEnforcement',
  },

  // ─── Output Format ────────────────────────────────────────
  output_protocol: {
    id: 'output_protocol',
    title: '输出结构与指令协议',
    category: '主剧情',
    description: '定义 AI 的输出标签结构（<正文>、<judge> 等）和指令场景规则',
    defaultPromptId: 'core',
  },
  setting_authority: {
    id: 'setting_authority',
    title: '作者设定标记',
    category: '主剧情',
    description: '解释 <设定> 标记的语义：本回合立即生效且长期有效（仅本回合含标记时注入）',
    defaultPromptId: 'settingAuthority',
  },
  setting_capture: {
    id: 'setting_capture',
    title: '设定提取协议',
    category: '主剧情',
    description: 'setting_updates 字段结构与提取规则（仅本回合含标记时注入）',
    defaultPromptId: 'settingCapture',
  },
  format_prompt: {
    id: 'format_prompt',
    title: '输出格式提示词',
    category: '主剧情',
    description: 'JSON 输出格式要求（step1 叙事 / step2 指令）',
    defaultPromptId: 'mainRound',
  },

  // ─── CoT ──────────────────────────────────────────────────
  main_cot: {
    id: 'main_cot',
    title: '主剧情 COT 协议',
    category: '主剧情',
    description: '思维链执行协议（Step0-Step14）',
    defaultPromptId: 'cot-preamble',
  },
  main_cot_judge: {
    id: 'main_cot_judge',
    title: '判定 COT 协议',
    category: '主剧情',
    description: '判定场景的专属思考链（Step0-Step8）',
    defaultPromptId: 'cot-judge',
  },
  cot_masquerade: {
    id: 'cot_masquerade',
    title: 'COT 伪装历史消息',
    category: '主剧情',
    description: '模拟 AI 已同意的格式承诺（prefill）',
    defaultPromptId: 'cot-masquerade',
  },

  // ─── Writing Style ────────────────────────────────────────
  write_style: {
    id: 'write_style',
    title: '写作文风',
    category: '主剧情',
    description: '叙事文风指导（画面感、节奏、措辞风格）',
    defaultPromptId: 'writeStyle',
  },
  write_anti_cliche: {
    id: 'write_anti_cliche',
    title: '反八股文',
    category: '主剧情',
    description: '禁止 AI 腔陈词滥调（句式套路、空洞排比、段尾升华、意象通胀）',
    defaultPromptId: 'antiCliche',
  },
  write_emotion_guard: {
    id: 'write_emotion_guard',
    title: '避免极端情绪',
    category: '主剧情',
    description: '禁止病理化渲染、情绪堆砌、宗教化语汇',
    defaultPromptId: 'emotionGuard',
  },
  write_no_control: {
    id: 'write_no_control',
    title: '禁止操控玩家',
    category: '主剧情',
    description: '禁止 AI 代写玩家心理、对白、决定或动作',
    defaultPromptId: 'noControl',
  },
  narrative_constraints: {
    id: 'narrative_constraints',
    title: '叙事总约束',
    category: '主剧情',
    description: '去神话化、去魅主、去发情化等 15 条叙事铁律',
    defaultPromptId: 'narrativeConstraints',
  },

  // ─── Perspective ──────────────────────────────────────────
  write_perspective_first: {
    id: 'write_perspective_first',
    title: '第一人称叙述',
    category: '主剧情',
    description: '使用"我"指代玩家的叙述模式',
    defaultPromptId: 'perspectiveFirst',
  },
  write_perspective_second: {
    id: 'write_perspective_second',
    title: '第二人称叙述',
    category: '主剧情',
    description: '使用"你"指代玩家的叙述模式（默认）',
    defaultPromptId: 'perspectiveSecond',
  },
  write_perspective_third: {
    id: 'write_perspective_third',
    title: '第三人称叙述',
    category: '主剧情',
    description: '使用角色姓名或"他/她"指代玩家的叙述模式',
    defaultPromptId: 'perspectiveThird',
  },

  // ─── Word Count ───────────────────────────────────────────
  write_req: {
    id: 'write_req',
    title: '字数要求',
    category: '主剧情',
    description: '每回合叙事正文的最低字数要求',
    defaultPromptId: 'wordCountReq',
  },

  // ─── Body Polish ──────────────────────────────────────────
  body_polish: {
    id: 'body_polish',
    title: '文章优化提示词',
    category: '文章优化',
    description: '后处理润色指令（保留事实、提升质感）',
    defaultPromptId: 'bodyPolish',
  },

  // ─── Environment Tags (P2 env-tags port, 2026-04-19) ──────
  //
  // Metadata-only slot: documents the `{{ENVIRONMENT_BLOCK}}` injection
  // point as a first-class customization surface. The block is currently
  // built at runtime by `src/engine/prompt/environment-block.ts` — there's
  // no `defaultPromptId` because there's no file-level prompt template yet.
  //
  // Rationale for registering anyway: discoverability in world-book editor
  // UI and consistency with other overridable blocks (MEMORY_BLOCK etc. are
  // similarly runtime-computed without slot entries, but those predate the
  // slot system). Future sessions can wire a `defaultPromptId` pointing at
  // an `environmentBlock.md` template if users want to override the format.
  environment_block: {
    id: 'environment_block',
    title: '环境信息块（天气/节日/环境标签）',
    category: '主剧情',
    description: '每回合注入的 【当前环境】 块；由 world.天气/节日/环境 运行时拼接',
  },

  // ─── Memory ───────────────────────────────────────────────
  npc_memory_summary: {
    id: 'npc_memory_summary',
    title: 'NPC 记忆总结提示词',
    category: '回忆',
    description: '单个 NPC 记忆压缩规则',
    defaultPromptId: 'npcMemorySummary',
  },

  // ─── Opening ──────────────────────────────────────────────
  opening_cot: {
    id: 'opening_cot',
    title: '开局 COT',
    category: '开局',
    description: '开局场景的思维链指导',
    defaultPromptId: 'cot-opening',
  },

  // ─── Action Options ───────────────────────────────────────
  action_options_action: {
    id: 'action_options_action',
    title: '行动选项（行动导向）',
    category: '主剧情',
    description: '行动导向模式的选项生成规范',
    defaultPromptId: 'actionOptions',
  },
  action_options_story: {
    id: 'action_options_story',
    title: '行动选项（剧情导向）',
    category: '主剧情',
    description: '剧情导向模式的选项生成规范',
    defaultPromptId: 'actionOptionsStory',
  },

  // ─── History Framing ──────────────────────────────────────
  history_framing: {
    id: 'history_framing',
    title: '历史对话说明',
    category: '常驻',
    description: '向 AI 解释 chat history 中 user/assistant 消息的结构',
    defaultPromptId: 'historyFraming',
  },

  // ─── Presence ─────────────────────────────────────────────
  presence_partition: {
    id: 'presence_partition',
    title: 'NPC 在场分区',
    category: '主剧情',
    description: '在场/离场 NPC 分区注入',
    defaultPromptId: 'presencePartition',
  },

  // ─── Plot Direction (Sprint Plot-1) ─────────────────────
  plot_directive: {
    id: 'plot_directive',
    title: '剧情引导',
    category: '剧情导向',
    description: '活跃弧线时注入的叙事方向引导和 gauge 状态',
    defaultPromptId: 'plotDirective',
  },
  plot_evaluation_step2: {
    id: 'plot_evaluation_step2',
    title: '节点评估 (Step2)',
    category: '剧情导向',
    description: 'Split-gen Step2 中的节点完成评估和 gauge 更新指令',
    defaultPromptId: 'plotEvaluationStep2',
  },
  plot_decompose: {
    id: 'plot_decompose',
    title: '大纲拆解',
    category: '剧情导向',
    description: '将玩家大纲拆解为节点链的 AI 指令（P1.5 启用）',
    defaultPromptId: 'plotDecompose',
  },
  plot_decompose_threads: {
    id: 'plot_decompose_threads',
    title: '多线拆解',
    category: '剧情导向',
    description: '将玩家大纲一次拆成 2-4 条剧情线及其先后关系（并行剧情线 epic）',
    defaultPromptId: 'plotDecomposeThreads',
  },
  plot_revise: {
    id: 'plot_revise',
    title: '续写/改写',
    category: '剧情导向',
    description: '按玩家要求续写或改写一条剧情线尚未发生的部分（续写/改写 epic）',
    defaultPromptId: 'plotRevise',
  },
  plot_revise_node: {
    id: 'plot_revise_node',
    title: '单节点重写',
    category: '剧情导向',
    description: '按玩家要求重写改写预览中的一个节点，保持与前后节点衔接（续写/改写 epic）',
    defaultPromptId: 'plotReviseNode',
  },
} as const;

/**
 * Get the slot IDs for a given category.
 */
export function getSlotsByCategory(category: string): BuiltinSlotDefinition[] {
  return Object.values(BUILTIN_SLOTS).filter((s) => s.category === category);
}

/**
 * Get all unique categories.
 */
export function getSlotCategories(): string[] {
  return [...new Set(Object.values(BUILTIN_SLOTS).map((s) => s.category))];
}
