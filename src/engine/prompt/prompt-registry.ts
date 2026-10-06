/**
 * Prompt 模块注册表 — 管理所有 prompt 模块的内容和启用状态
 *
 * 每个 prompt 模块（如 "coreOutputRules", "businessRules"）在此注册：
 * - 包含 Game Pack 提供的默认内容
 * - 支持用户覆盖内容（getEffectiveContent 返回用户版本 > 默认版本）
 * - 支持启用/禁用
 *
 * 对应 STEP-03B M2.6 prompt-registry.ts。
 * 参照 demo: defaultPrompts.ts + promptStorage.ts 的双层模型。
 */

/** 单个 prompt 模块的注册信息 */
export interface PromptModule {
  /** 唯一标识（对应 Game Pack 的 prompts/{id}.md） */
  id: string;
  /** Game Pack 提供的默认内容 */
  content: string;
  /** 用户覆盖的内容（undefined = 使用默认） */
  userContent?: string;
  /** 是否启用（禁用的模块在组装时跳过） */
  enabled: boolean;
  /**
   * Sent whenever a request uses it: the player's text applies, being switched off does not (a round cannot do
   * without it, or a setting chooses it). Empty text falls back to the pack's.
   */
  alwaysOn?: boolean;
  /** 模块元数据（用于 UI 展示） */
  metadata?: {
    name?: string;
    category?: string;
    description?: string;
  };
}

export class PromptRegistry {
  private modules = new Map<string, PromptModule>();

  /** 注册一个 prompt 模块 */
  register(module: PromptModule): void {
    this.modules.set(module.id, module);
  }

  /**
   * Register a pack's prompts (its default texts), each on; the ids `alwaysOn` holds for can never be switched off
   * (the app passes isPromptAlwaysOn). The one place a pack's prompts become modules, so the app and its tests build
   * the same registry.
   */
  registerPack(prompts: Readonly<Record<string, string>>, alwaysOn: (promptId: string) => boolean): void {
    for (const [id, content] of Object.entries(prompts)) {
      this.register({ id, content, enabled: true, alwaysOn: alwaysOn(id) });
    }
  }

  /** 按 ID 获取模块 */
  get(id: string): PromptModule | undefined {
    return this.modules.get(id);
  }

  /** 获取所有已注册的模块 */
  getAll(): PromptModule[] {
    return Array.from(this.modules.values());
  }

  /**
   * 获取模块的生效内容
   * 优先返回用户覆盖内容，否则返回默认内容
   * 模块被禁用时返回空字符串；always-on 模块不看开关，用户内容为空时用默认内容
   */
  getEffectiveContent(id: string): string {
    const mod = this.modules.get(id);
    if (!mod) return '';
    if (mod.alwaysOn) return mod.userContent?.trim() ? mod.userContent : mod.content;
    if (!mod.enabled) return '';
    return mod.userContent ?? mod.content;
  }

  /** 设置用户覆盖内容 */
  setUserContent(id: string, content: string): void {
    const mod = this.modules.get(id);
    if (mod) mod.userContent = content;
  }

  /** 重置模块到默认内容（移除用户覆盖） */
  resetToDefault(id: string): void {
    const mod = this.modules.get(id);
    if (mod) mod.userContent = undefined;
  }

  /** 设置模块的启用状态 */
  setEnabled(id: string, enabled: boolean): void {
    const mod = this.modules.get(id);
    if (mod) mod.enabled = enabled;
  }

  /** 检查模块是否已注册 */
  has(id: string): boolean {
    return this.modules.has(id);
  }

  /** 清空所有模块 — 切换 Game Pack 时调用 */
  clear(): void {
    this.modules.clear();
  }
}
