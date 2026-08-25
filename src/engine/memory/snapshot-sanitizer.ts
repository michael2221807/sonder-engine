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
 * 实现选择 — JSON.stringify replacer vs 深拷贝：
 * ------------------------------------------------
 * 我们用 replacer 而非深拷贝剥离，原因：
 * 1. 零额外内存 — replacer 在序列化流程中直接 return undefined 过滤 key
 * 2. 性能 — 长游戏状态树可能几十 MB，深拷贝再遍历删字段会显著变慢
 * 3. 简洁 — 代码只有几行，无需递归遍历 NPC 数组
 *
 * replacer 局限：
 * 它按 `(key, value)` 回调，没有完整的"路径上下文"。所以我们只能按 key 名称匹配：
 * - `私密信息` 唯一出现在 NPC 对象下，按 key 名过滤安全
 * - `身体` 唯一出现在 `角色` 下（NPC 用的是 `身体部位` 复数），按 key 名过滤安全
 *
 * ⚠️ 未来扩展警告：
 * 如果 schema 新增其他地方使用 `身体` 或 `私密信息` 作为 key，
 * 这个 replacer 会误伤。届时需要改成"带路径上下文"版本（WeakMap 追踪节点父链）。
 *
 * 对应 GAP_AUDIT §11.2 C（保留数据 + 不发送给 AI + UI 可见）。
 */

/**
 * 需要被剥离的 NSFW 路径前缀（绝对路径，从根开始）
 *
 * CR-R6 修复（2026-04-11）：从 key-only 匹配升级为 path-aware 匹配。
 *
 * 旧实现用 JSON.stringify replacer 按 key 名剥离（`私密信息` / `身体`），
 * 风险：如果未来 schema 在非 NSFW 位置添加同名 key（如 `世界.地点信息[].身体特征描述`），
 * 会被意外剥离。新实现按**完整路径前缀**匹配，零误伤。
 *
 * 新的 NSFW 字段必须添加到此数组。
 */
const NSFW_STRIP_PATHS: readonly string[] = [
  // 每个 NPC 对象下的 `私密信息` 字段（`社交.关系[i].私密信息`）
  // 路径使用 `.*.` 风格：`社交.关系.*.私密信息` 表示"社交.关系 下任意数组元素的 私密信息"
  '社交.关系.*.私密信息',
  // 玩家法身
  '角色.身体',
];

/**
 * 2026-04-11 Token 节省 —— 发给 AI 的 JSON 快照里总是需要剥离的路径。
 *
 * 这些路径的内容在 prompt 里通过**其他更紧凑的渠道**单独注入，所以在
 * `GAME_STATE_JSON` 里留着就是纯粹的重复。用户报告单轮 prompt 里含有
 * "巨量重复内容"，绝大多数来自这几项：
 *
 * 1. **`元数据.叙事历史`**
 *    已经通过 `chatHistory` 变成真正的 `user/assistant` 消息追加到消息列表。
 *    如果再序列化进 `GAME_STATE_JSON`，完整的历史被复制一份，而且是
 *    JSON 形式（对 AI 更难读）。200 条历史上限 × 含元数据的完整 dump
 *    可能占到 30%+ 的 prompt 体积。
 *
 * 2. **`记忆.短期 / 中期 / 长期 / 隐式中期`**
 *    已经通过 `MemoryRetriever.retrieve()` 编译为结构化的 `MEMORY_BLOCK`
 *    （按层级分组 + 编号列表），这是 AI 专用的人类可读形态。再把相同数据
 *    以 JSON 形式塞进 `GAME_STATE_JSON` 完全是浪费。
 *
 * 3. **`系统.扩展.engramMemory`**
 *    这是 Engram 子系统内部的**事件/实体/关系/向量元数据**存储，单条
 *    EngramEventNode 可能有 text/summary/embedding/timestamp/relations 等
 *    多个字段，数百条事件展开后动辄数万字。AI 消费的是 `UnifiedRetriever`
 *    根据 query 检索出的少量相关片段（已并入 `MEMORY_BLOCK`），从不直接
 *    读 engramMemory 节点。所以这段应该完全从 GAME_STATE_JSON 剥离。
 *
 * 4. **`元数据.上次对话前快照`**
 *    用于 Rollback 功能 —— 整个上一回合前的完整状态树克隆。
 *    **最致命的重复**：如果不剥，每次 prompt 里实际包含两份完整状态树
 *    （本回合 + 上回合）。纯内部机制，AI 绝对不应看到。
 *
 * 5. **`系统.扩展.image` / `角色.图片档案` / `社交.关系.*.图片档案`**
 *    图像生成子系统的全部配置 / presets / anchors / rules / task queue /
 *    sceneArchive / persistentWallpaper，以及玩家和每个 NPC 的生图历史
 *    和资产 ID。纯 UI/引擎内部状态，AI 不需要。
 *    注意：`image.config.transformer` 子树含 apiKey / endpoint（独立转化器模型配置，
 *    由 ImagePanel 写入状态树），另外 additionalNetworksJson 等可能含用户本地路径。
 *    整棵 `系统.扩展.image` 被 strip 覆盖，敏感字段不会泄漏。
 *
 * 6. **子系统运行时设置 / UI 状态 / 日志**
 *    `系统.设置` / `系统.actionOptions` 由 ContextAssembly 读取后以专门变量
 *    或开关影响 prompt；`元数据.当前行动选项` 只用于刷新后恢复 UI；
 *    `世界.状态.心跳` 是心跳配置和执行日志。这些都不是叙事世界事实。
 *
 * 7. **`社交.关系.*.私聊历史`**
 *    私聊原文由 NPC 私聊 UI 独立保存。主线 AI 需要知道的摘要会写入 NPC
 *    的 `记忆` 字段，因此原始私聊明细不应随 NPC 对象整段进入 GAME_STATE_JSON。
 *
 * 8. **`系统.扩展.语义记忆`** — **暂不 strip**
 *    语义三元组（TripleBuilder 写入）。当前无检索链路消费此路径（UnifiedRetriever
 *    读的是 engramMemory，不是语义记忆）。strip 会导致旧存档 triples 静默消失。
 *    待补 retrieval 注入后再启用 strip。数组无 maxItems 限制，长期可能增长较大。
 *
 * 9. **`系统.探索记录`**
 *    每回合后 post-process 自动写入当前位置的数组，某些 pack 可能会
 *    写大量条目。考虑到它已经隐含在 `地点信息` 的 `已探索` 标志里，
 *    重复放进 JSON 对 AI 没价值。先不强制剥离以保持向后兼容 —
 *    若未来变成瓶颈再加。
 *
 * **注意**：`元数据.女主规划` 不在此列表。legacy flow 依赖它在 GAME_STATE_JSON
 * 中出现；new builder 虽然会通过 heroine_plan 单独注入（导致重复），但 strip
 * 会破坏 legacy 回退路径。等 legacy 完全移除后再考虑剥离。
 *
 * 加入此数组的路径**无条件**从发给 AI 的快照中剥离（与 NSFW 开关无关）。
 */
const PROMPT_ALWAYS_STRIP_PATHS: readonly string[] = [
  '元数据.叙事历史',
  '元数据.上次对话前快照',
  '元数据.当前行动选项',
  '元数据.推理历史',
  '元数据.剧情规划',
  '元数据.剧情导向',
  // 玩家收藏楼层：正文快照大数组，pending 项已通过 {{BOOKMARKED_ROUNDS_BLOCK}}
  // 专用块注入，不应在 GAME_STATE_JSON 里重复(去重/瘦身)。
  '元数据.收藏楼层',
  '记忆.短期',
  '记忆.中期',
  '记忆.长期',
  '记忆.隐式中期',
  '系统.扩展.engramMemory',
  '系统.扩展.image',
  // Canon Capture: auto-captured settings reach the model through the world-book
  // budget block (deduped + budgeted). Leaving them in GAME_STATE_JSON would inject
  // every entry raw, every round, bypassing the budget entirely.
  '系统.扩展.slotWorldBooks',
  // Canon Capture round telemetry for the panel banner — pure UI feedback, never
  // something the model should read back.
  '系统.扩展.settingCaptureLast',
  // '系统.扩展.语义记忆' — 暂不 strip：当前无检索链路消费该路径，
  // strip 会导致旧存档 triples 静默消失。待补 retrieval 注入后再启用。
  '系统.设置',
  '系统.actionOptions',
  '世界.状态.心跳',
  '角色.图片档案',
  '社交.关系.*.图片档案',
  '社交.关系.*.私聊历史',
  '社交.关系.*.总结记忆',
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
export function stripTagFromText(text: string, tag: string): string {
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
 */
export function stripTagFromMessages<T extends { content: string }>(
  messages: readonly T[],
  tag: string,
): T[] {
  return messages.map((msg) => {
    const stripped = stripTagFromText(msg.content, tag);
    if (stripped === msg.content) return msg;
    return { ...msg, content: stripped };
  });
}
