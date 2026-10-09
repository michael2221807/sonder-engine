/**
 * 快照脱敏 — 在 GAME_STATE_JSON 序列化前根据 NSFW 开关剥离私密字段
 *
 * 用途：
 * ContextAssemblyStage 把完整状态树通过 `{{GAME_STATE_JSON}}` 变量注入 prompt 发给 AI。
 * 当 `系统.nsfwMode=false` 时，必须从发送给 AI 的副本中剥离：
 *   - 每个 NPC 对象的 `私密信息` 字段（嵌套在 `社交.关系[].私密信息`）
 *   - 玩家法身 `角色.身体` 对象
 *
 * 关键约束（用户明确要求）：
 * - 不能删除原始状态树中的数据（存档必须保留完整信息）
 * - 仅在发送给 AI 的"那一次"序列化中剥离
 * - UI 面板可以继续显示（GameVariablePanel 全程可见所有字段）
 *
 * 实现：路径感知的深拷贝（sanitizeDeep）。按**完整路径**匹配 NSFW_STRIP_PATHS /
 * PROMPT_ALWAYS_STRIP_PATHS，命中的节点不写入副本，原状态树不受影响。
 * Changelog: 2026-04-11 CR-R6，由按 key 名过滤的 JSON.stringify replacer 改来。
 *
 * 对应 GAP_AUDIT §11.2 C（保留数据 + 不发送给 AI + UI 可见）。
 */

import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { SYSTEM_PATHS } from '../pipeline/system-paths';

/**
 * 需要被剥离的 NSFW 路径前缀（绝对路径，从根开始）
 *
 * 按**完整路径前缀**匹配，不按 key 名匹配：schema 在别处出现同名 key
 *（如 `世界.地点信息[].身体特征描述`）不会被误伤。
 *
 * 新的 NSFW 字段必须添加到此数组。
 */
const NSFW_STRIP_PATHS: readonly string[] = [
  // 每个 NPC 对象下的 `私密信息` 字段（`社交.关系[i].私密信息`）
  // 路径使用 `.*.` 风格：`社交.关系.*.私密信息` 表示"社交.关系 下任意数组元素的 私密信息"
  `${DEFAULT_ENGINE_PATHS.relationships}.*.${DEFAULT_ENGINE_PATHS.npcFieldNames.privacyProfile}`,
  // 玩家法身
  DEFAULT_ENGINE_PATHS.playerBody,
];

/**
 * 发给 AI 的 JSON 快照里总是需要剥离的路径（Token 节省 + 隐私）。
 *
 * 这些路径的内容要么已经通过**其他更紧凑的渠道**单独注入 prompt，留在
 * `GAME_STATE_JSON` 里就是纯粹的重复；要么是纯 UI / 引擎内部状态：
 *
 * 1. `元数据.叙事历史` — 已经通过 `chatHistory` 变成 user/assistant 消息。
 * 2. `记忆.短期 / 中期 / 长期 / 隐式中期` — 已编译进结构化的 `MEMORY_BLOCK`。
 * 3. `系统.扩展.engramMemory` — Engram 的事件/实体/关系/向量元数据；AI 只读 UnifiedRetriever
 *    检索出的少量片段（已并入 `MEMORY_BLOCK`）。
 * 4. `元数据.上次对话前快照` — Rollback 用的整棵状态树克隆；不剥等于 prompt 里有两份状态树。存档瘦身 D1A 之后
 *    树里放的是 `系统.扩展.rollbackPatch`（回退标记 / 读档时的回退差异，可有数十万字符，含旧值）和
 *    `系统.扩展.saveFormat`（引擎存档格式标记）——都是引擎内部数据，同样无条件剥离。
 * 5. `系统.扩展.image` / `角色.图片档案` / `社交.关系.*.图片档案` — 生图子系统的配置、任务队列和
 *    资产 ID。`image.config.transformer` 含 apiKey / endpoint，整棵子树被剥离所以不会泄漏。
 * 6. `系统.设置` / `系统.actionOptions` / `元数据.当前行动选项` / `世界.状态.心跳` — 运行时设置、
 *    UI 恢复状态和心跳日志，不是叙事世界事实。
 * 7. `社交.关系.*.私聊历史` — 私聊原文由私聊 UI 独立保存；主线 AI 需要的摘要在 NPC 的 `记忆` 里。
 * 8. `系统.扩展.语义记忆` — **不剥离**：旧存档可能带有语义三元组（TripleBuilder 已删除，现在没有代码写入它），
 *    保持原样以免旧存档内容静默消失。
 * 9. `系统.探索记录` — 也**不强制剥离**（保持向后兼容）；若变成瓶颈再加。
 *
 * `元数据.女主规划` 也不在此列表：SystemPromptBuilder 另有 heroine_plan 片段，它与 GAME_STATE_JSON 里
 * 的副本重复，但 flow 路径依赖后者。
 *
 * 加入此数组的路径**无条件**从发给 AI 的快照中剥离（与 NSFW 开关无关）。
 */
const PROMPT_ALWAYS_STRIP_PATHS: readonly string[] = [
  DEFAULT_ENGINE_PATHS.plotVector,
  DEFAULT_ENGINE_PATHS.narrativeHistory,
  DEFAULT_ENGINE_PATHS.preRoundSnapshot,
  DEFAULT_ENGINE_PATHS.rollbackPatch,
  DEFAULT_ENGINE_PATHS.saveFormat,
  DEFAULT_ENGINE_PATHS.currentActionOptions,
  DEFAULT_ENGINE_PATHS.reasoningHistory,
  DEFAULT_ENGINE_PATHS.storyPlan,
  DEFAULT_ENGINE_PATHS.plotDirection,
  // 玩家收藏楼层：正文快照大数组，pending 项已通过 {{BOOKMARKED_ROUNDS_BLOCK}}
  // 专用块注入，不应在 GAME_STATE_JSON 里重复(去重/瘦身)。
  DEFAULT_ENGINE_PATHS.bookmarkedRounds,
  DEFAULT_ENGINE_PATHS.shortTermMemory,
  DEFAULT_ENGINE_PATHS.memoryMidTerm,
  DEFAULT_ENGINE_PATHS.memoryLongTerm,
  DEFAULT_ENGINE_PATHS.implicitMidTermMemory,
  DEFAULT_ENGINE_PATHS.engramMemory,
  SYSTEM_PATHS.image.root,
  // Canon Capture: auto-captured settings reach the model through the world-book
  // budget block (deduped + budgeted). Leaving them in GAME_STATE_JSON would inject
  // every entry raw, every round, bypassing the budget entirely.
  DEFAULT_ENGINE_PATHS.slotWorldBooks,
  // Canon Capture round telemetry for the panel banner — pure UI feedback, never
  // something the model should read back.
  DEFAULT_ENGINE_PATHS.settingCaptureLast,
  // Save-health baseline (2026-09-10): device-side bookkeeping of which world books the
  // library held. Meaningless to the model and never something it should read.
  DEFAULT_ENGINE_PATHS.storageHealth,
  // Narrative Contract (R2): the player's clauses reach the model through their own
  // block (sent to both split steps, see prompt/narrative-contract.ts). Leaving the
  // raw object in GAME_STATE_JSON would duplicate it and expose `proposed` clauses
  // the player has not accepted.
  DEFAULT_ENGINE_PATHS.narrativeContract,
  // Character Vectors (R2 second half): projected per turn into their own block; the raw
  // list would leak every NPC's hidden truth into GAME_STATE_JSON.
  DEFAULT_ENGINE_PATHS.characterVectors,
  // '系统.扩展.语义记忆' — 不 strip：旧存档可能带有语义三元组，保持原样（见上方第 8 条）。
  SYSTEM_PATHS.settings,
  SYSTEM_PATHS.actionOptions,
  DEFAULT_ENGINE_PATHS.heartbeatRoot,
  DEFAULT_ENGINE_PATHS.playerImageArchive,
  `${DEFAULT_ENGINE_PATHS.relationships}.*.${DEFAULT_ENGINE_PATHS.npcFieldNames.imageArchive}`,
  `${DEFAULT_ENGINE_PATHS.relationships}.*.${DEFAULT_ENGINE_PATHS.npcFieldNames.privateChatHistory}`,
  `${DEFAULT_ENGINE_PATHS.relationships}.*.${DEFAULT_ENGINE_PATHS.npcFieldNames.memorySummaries}`,
  // The engine's own record of the round the main round last updated each NPC (the heartbeat's 遗忘回合数):
  // bookkeeping, nothing the model should read or write.
  `${DEFAULT_ENGINE_PATHS.relationships}.*.${DEFAULT_ENGINE_PATHS.npcFieldNames.lastMainRoundUpdate}`,
  'NPC列表',
];

/**
 * 判断某字段路径是否命中 NSFW strip 规则
 *
 * 路径语法：`社交.关系.*.私密信息` 中的 `*` 匹配任意 key（包括数字索引）。
 * 完全字符串匹配 + 通配符段。
 */
function pathMatchesStripRule(path: string, rule: string): boolean {
  const pathParts = path.split('.');
  const ruleParts = rule.split('.');
  if (pathParts.length !== ruleParts.length) return false;
  for (let i = 0; i < ruleParts.length; i++) {
    if (ruleParts[i] === '*') continue;
    if (ruleParts[i] !== pathParts[i]) return false;
  }
  return true;
}

/**
 * 判断是否应剥离。两类路径：
 * - `PROMPT_ALWAYS_STRIP_PATHS`：无条件剥离（去重 / 瘦身）
 * - `NSFW_STRIP_PATHS`：仅在 `nsfwMode=false` 时剥离
 */
function shouldStripAtPath(
  path: string,
  nsfwMode: boolean,
  additionalPaths?: readonly string[],
): boolean {
  for (const rule of PROMPT_ALWAYS_STRIP_PATHS) {
    if (pathMatchesStripRule(path, rule)) return true;
  }
  if (!nsfwMode) {
    for (const rule of NSFW_STRIP_PATHS) {
      if (pathMatchesStripRule(path, rule)) return true;
    }
  }
  if (additionalPaths) {
    for (const rule of additionalPaths) {
      if (pathMatchesStripRule(path, rule)) return true;
    }
  }
  return false;
}

/**
 * Path-aware 深拷贝 + 剥离
 *
 * 遍历整棵 snapshot，对每个节点判断其路径是否命中 NSFW_STRIP_PATHS，命中则省略。
 * 返回脱敏后的深拷贝（原 snapshot 不受影响）。
 *
 * 算法：
 * - 对象：遍历 own keys，递归处理每个 value
 * - 数组：遍历 index，递归处理每个 element
 * - 原始值：直接 clone
 * - null/undefined：直接返回
 *
 * 命中 strip 规则的节点返回 `undefined`；在对象上下文里，对应 key 直接不写入；
 * 在数组上下文里，命中 strip 的元素被 skip（不保留位置），后续索引前移。
 * 当前所有 strip 规则都作用于对象键而非数组元素本身，所以索引变化无实际影响。
 */
function sanitizeDeep(
  value: unknown,
  path: string,
  nsfwMode: boolean,
  additionalPaths?: readonly string[],
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const childPath = `${path}.${i}`;
      if (shouldStripAtPath(childPath, nsfwMode, additionalPaths)) continue;
      result.push(sanitizeDeep(value[i], childPath, nsfwMode, additionalPaths));
    }
    return result;
  }

  // Plain object
  const result: Record<string, unknown> = {};
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const childPath = path ? `${path}.${key}` : key;
    if (shouldStripAtPath(childPath, nsfwMode, additionalPaths)) continue;
    result[key] = sanitizeDeep(obj[key], childPath, nsfwMode, additionalPaths);
  }
  return result;
}

/**
 * 便捷封装 — 直接产生脱敏后的 JSON 字符串
 *
 * @param snapshot 状态树快照（通常来自 `stateManager.toSnapshot()`）
 * @param nsfwMode 当前 NSFW 开关状态
 * @param indent   JSON 缩进。**默认 0（紧凑）** — 2026-04-11 token 节省修复。
 *                 之前默认 2 会在每行写 2 空格缩进，一个含数千字段的状态树
 *                 JSON 可被膨胀 30-50%。传 2 仅在需要人类可读调试时用。
 */
export function stringifySnapshotForPrompt(
  snapshot: Record<string, unknown>,
  nsfwMode: boolean,
  indent: number = 0,
  additionalStripPaths?: readonly string[],
): string {
  // 2026-04-11：无论 nsfwMode 是什么都要做 sanitizeDeep —
  // 原来 nsfwMode=true 时走的快捷 JSON.stringify(snapshot) 路径会把叙事历史/
  // 记忆/engramMemory 等**总是**要剥离的重复路径也原样发送出去。新版本总是
  // 走 sanitizeDeep，由 `shouldStripAtPath` 按 nsfwMode 决定是否叠加 NSFW 规则。
  const cleaned = sanitizeDeep(snapshot, '', nsfwMode, additionalStripPaths);
  return indent > 0
    ? JSON.stringify(cleaned, null, indent)
    : JSON.stringify(cleaned);
}

/**
 * @deprecated Use `stringifySnapshotForPrompt` instead. Kept for backward compat.
 * CR-R6: key-only replacer had false-positive risk on future same-name keys.
 */
export function makeNsfwStripReplacer(): (key: string, value: unknown) => unknown {
  return (key: string, value: unknown): unknown => {
    if (key === '') return value;
    if (key === '私密信息') return undefined;
    if (key === '身体') return undefined;
    return value;
  };
}

// ─── Prompt 文本层的 [私密] tag 剥离 ─────────────────────────────
//
// 架构说明：
// ContextAssemblyStage 组装 prompt 时经历：raw prompt content → templateEngine.render → messages[].content。
// 所以 `[私密]...[/私密]` tag 最终出现在每条 message 的 content 字符串里，
// 不在 variables 字典里。`ContentFilterModule.onContextAssembly(variables)` 的签名
// 只能改 variables，无法触及 message content → 我们用独立工具在 assemble() 之后做一次
// messages 级别的剥离。
//
// 为什么不改 ContentFilterModule：
// 扩展 BehaviorRunner.runOnContextAssembly 的签名以传递 messages 会污染其他钩子；
// ContentFilterModule 对其他评级仍有价值（例如暴力 tag 可以只在模板变量里出现），
// 所以保留它。NSFW 作为 special case 走直接剥离路径。

/** 默认的 NSFW 评级 tag（中文）— 避开英文模型的关键词内容过滤 */
export const NSFW_STRIP_TAG = '私密';

/**
 * 从一段 prompt 文本中剥离 `[tag]...[/tag]` 包裹的段落
 *
 * - 跨行匹配（`[\s\S]*?` 非贪婪，避免多段落被合并吞掉）
 * - 按字面字符匹配（CR-R24，2026-04-11：移除 `i` 标志——中文 tag 无大小写概念，
 *   保留 `i` 是历史遗留。显式按字面匹配避免误伤大小写敏感场景）
 * - 剥离后清理连续空行（>=3 换行压缩为 2）
 */
function stripTagFromText(text: string, tag: string): string {
  if (!text) return text;
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\[${escaped}\\][\\s\\S]*?\\[\\/${escaped}\\]`, 'g');
  const stripped = text.replace(pattern, '');
  if (stripped === text) return text;
  return stripped.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 遍历一组 AIMessage，对每条 message.content 剥离指定 tag
 *
 * - 返回新数组，不修改原数组中的 message 对象（浅拷贝每项）
 * - 无变更的 message 保持原引用（减少不必要的对象分配）
 * - 多模态块内容：只处理 text 块，image 块原样保留
 *
 * 泛型约束刻意内联块形状而非 import AIContentBlock（本文件只依赖引擎路径常量，不依赖 AI 层类型）；
 * 未来新增块类型会走 `type !== 'text'` 分支被原样透传（安全无操作）。
 */
export function stripTagFromMessages<
  T extends { content: string | Array<{ type: 'text'; text: string } | { type: 'image'; dataUrl: string }> },
>(
  messages: readonly T[],
  tag: string,
): T[] {
  return messages.map((msg) => {
    if (Array.isArray(msg.content)) {
      let changed = false;
      const blocks = msg.content.map((block) => {
        if (block.type !== 'text') return block;
        const stripped = stripTagFromText(block.text, tag);
        if (stripped === block.text) return block;
        changed = true;
        return { ...block, text: stripped };
      });
      return changed ? { ...msg, content: blocks } : msg;
    }
    const stripped = stripTagFromText(msg.content, tag);
    if (stripped === msg.content) return msg;
    return { ...msg, content: stripped };
  });
}
