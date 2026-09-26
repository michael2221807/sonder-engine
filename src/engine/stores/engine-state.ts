import { defineStore } from 'pinia';
import { ref, computed, triggerRef } from 'vue';
import { get as _get } from 'lodash-es';
import type { GameStateTree, StatePath } from '../types';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import type { StateManager } from '../core/state-manager';
import { eventBus } from '../core/event-bus';

/**
 * Primary game state store — reactive GameStateTree for Vue + Pinia
 *
 * Demo 对照：`H:\ming\src\stores\gameStateStore.ts` 使用分模块 Pinia 字段；
 * 正式版改为单一 JSON 树 + dot-path（STEP-02），本 store 即该树的宿主。
 *
 * 顶栏/侧栏展示的姓名、位置必须与管线 `ContextAssemblyStage` 注入的
 * PLAYER_NAME / CURRENT_LOCATION 同源，路径取自 `DEFAULT_ENGINE_PATHS`，
 * 禁止在此手写与 pipeline/types 不一致的字符串。
 */
export const useEngineStateStore = defineStore('engineState', () => {
  const P = DEFAULT_ENGINE_PATHS;
  const isGameLoaded = ref(false);
  const activePackId = ref<string | null>(null);
  const activeProfileId = ref<string | null>(null);
  const activeSlotId = ref<string | null>(null);

  /** The reactive state tree — Vue components can use this in templates */
  const tree = ref<GameStateTree>({});

  /**
   * 持有 linkStateManager 注入的 StateManager 实例引用。
   * loadGame() 需要通过它将数据就地写入响应式对象，而非替换 tree.value 引用。
   */
  let _linkedStateManager: StateManager | null = null;

  /**
   * 持有 linkBehaviorRunner 注入的 BehaviorRunner 引用（与 linkStateManager 同模式）。
   *
   * 2026-07-05 之前 runOnGameLoad 只在 CharacterInitPipeline（创角）里触发，
   * 真实读档（HomeView / ManagementView / 卡片导入 activateSave）从不执行
   * onGameLoad 钩子——effect-lifecycle 的过期清理、npc-dedup 的同名 NPC 融合、
   * validation-repair 的存档修复在读档时全部是死钩子。注入后 loadGame() 在
   * loadTree 之后统一分发 onGameLoad，历史脏存档读档即自愈。
   */
  let _linkedBehaviorRunner: { runOnGameLoad(sm: StateManager): void } | null = null;

  /** Convenience getter: retrieve a value by dot-path */
  function get<T = unknown>(path: StatePath): T | undefined {
    return _get(tree.value, path) as T | undefined;
  }

  /** Pack display name (read from manifest metadata in the tree) */
  const packName = computed(() =>
    (get<string>('元数据.游戏包名称') ?? activePackId.value ?? '未知游戏包'),
  );

  /** Character display name — same path as prompt template PLAYER_NAME */
  const characterName = computed(() =>
    get<string>(P.playerName) ?? '未命名角色',
  );

  /** Current location — same path as prompt template CURRENT_LOCATION */
  const currentLocation = computed(() =>
    get<string>(P.playerLocation) ?? '未知',
  );

  /** In-game time display — 年月日 HH:MM */
  const gameTime = computed(() => {
    const year = get<number>(P.gameTime + '.年') ?? 0;
    const month = get<number>(P.gameTime + '.月') ?? 0;
    const day = get<number>(P.gameTime + '.日') ?? 0;
    if (!year && !month && !day) return '未知时间';
    const hour = get<number>(P.gameTimeHour) ?? null;
    const minute = get<number>(P.gameTimeMinute) ?? null;
    const timePart = (hour !== null && minute !== null)
      ? ` ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      : '';
    return `${year}年${month}月${day}日${timePart}`;
  });

  /** Current round number */
  const roundNumber = computed(() => get<number>('元数据.回合序号') ?? 0);

  /** 体力 {当前, 上限} */
  const vitalHealth = computed(() =>
    get<{ 当前: number; 上限: number }>(P.vitalHealth) ?? { 当前: 100, 上限: 100 },
  );

  /** 精力 {当前, 上限} */
  const vitalEnergy = computed(() =>
    get<{ 当前: number; 上限: number }>(P.vitalEnergy) ?? { 当前: 100, 上限: 100 },
  );

  /** 状态效果数组（buff/debuff） */
  const statusEffects = computed(() =>
    get<Array<{ 状态名称: string; 类型: string; 状态描述: string; 持续时间分钟?: number }>>(P.statusEffects) ?? [],
  );

  /** 声望数值 */
  const reputation = computed(() => get<number>(P.reputation) ?? 0);

  /** 天赋列表 [{名称, 描述}, ...] */
  const talents = computed(() => {
    const raw = get<unknown>(P.talents);
    if (!Array.isArray(raw)) return [] as Array<{ 名称: string; 描述: string }>;
    return raw.map((item) => {
      if (typeof item === 'string') return { '名称': item, '描述': '' };
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        return { '名称': typeof o['名称'] === 'string' ? o['名称'] : '', '描述': typeof o['描述'] === 'string' ? o['描述'] : '' };
      }
      return { '名称': '', '描述': '' };
    });
  });

  /**
   * Load game state from a snapshot.
   *
   * 若 StateManager 已通过 linkStateManager() 注入，则调用其 loadTree() 就地更新
   * 响应式状态树，保持 tree.value 与 StateManager.state 的共享引用不变。
   *
   * 禁止直接 tree.value = data：这会替换引用，切断 Pinia 与 StateManager 的响应式链接，
   * 导致 AI 命令写入 StateManager 后 UI 不更新（"双轨不同步"问题，见 CODE_REVIEW #3）。
   */
  function loadGame(
    data: GameStateTree,
    packId: string,
    profileId: string,
    slotId: string,
  ): void {
    if (_linkedStateManager) {
      // 就地写入：保持 tree.value 与 StateManager.state 是同一个 reactive proxy
      _linkedStateManager.loadTree(data as Record<string, unknown>);
      // 读档后行为钩子：npc-dedup 同名融合 / effect-lifecycle 过期清理 /
      // validation-repair 存档修复等（各模块 onGameLoad JSDoc 均声明面向读档场景）
      _linkedBehaviorRunner?.runOnGameLoad(_linkedStateManager);
    } else {
      // 降级路径：StateManager 未注入时（如测试或 fallback），直接替换 ref
      tree.value = data;
    }
    isGameLoaded.value = true;
    activePackId.value = packId;
    activeProfileId.value = profileId;
    activeSlotId.value = slotId;
    syncNsfwFromLocalStorage();
    syncAllSettingsFromLocalStorage();
  }

  /**
   * Mark the current state as "loaded" without touching the tree data.
   *
   * §C4 GAP_AUDIT: 用于 CharacterInitPipeline 完成后的场景 —
   * 此时 stateManager 已经保存了完整的初始状态（via loadTree + AI commands），
   * 并且 Pinia tree 与 stateManager.state 共享同一 reactive proxy，
   * 所以不需要再通过 IDB 读回+loadGame 的往返，只需要更新元数据字段。
   *
   * 与 loadGame 的区别：
   * - loadGame: 接收一份外部 data，调 stateManager.loadTree 重置整棵树 + 设置元数据
   * - markLoaded: 不动数据，只设置元数据标记（isGameLoaded / activePackId 等）
   */
  function markLoaded(packId: string, profileId: string, slotId: string): void {
    isGameLoaded.value = true;
    activePackId.value = packId;
    activeProfileId.value = profileId;
    activeSlotId.value = slotId;
    syncNsfwFromLocalStorage();
    syncAllSettingsFromLocalStorage();
  }

  /**
   * 从 localStorage 同步 NSFW 设置到状态树。
   *
   * 之前此逻辑仅在 SettingsPanel 的 onMounted / watch(isLoaded) 中执行，
   * 导致面板未挂载时（如创角后直接进入游戏）状态树中的 nsfwMode 停留在
   * schema 默认值 false，即使用户已在设置中开启。
   *
   * 现在在 loadGame / markLoaded 时统一同步，确保游戏可用时 nsfwMode 总是
   * 反映用户的最新偏好。
   */
  function syncNsfwFromLocalStorage(): void {
    try {
      const raw = localStorage.getItem('aga_nsfw_settings');
      if (!raw) return;
      const parsed = JSON.parse(raw) as { nsfwMode?: boolean; nsfwGenderFilter?: string };
      if (typeof parsed.nsfwMode === 'boolean') {
        setValue('系统.nsfwMode', parsed.nsfwMode);
      }
      const validFilters = ['all', 'male', 'female'];
      if (typeof parsed.nsfwGenderFilter === 'string' && validFilters.includes(parsed.nsfwGenderFilter)) {
        setValue('系统.nsfwGenderFilter', parsed.nsfwGenderFilter);
      }
    } catch { /* no-op */ }
  }

  /**
   * 从 localStorage 恢复所有引擎设置到状态树。
   *
   * 问题：heartbeat/actionOptions 等设置存在 localStorage 但游戏重启后
   * 状态树从 schema 默认值重建，覆盖了用户的偏好。NSFW 有专门的 sync，
   * 但其他设置没有。此函数统一处理。
   *
   * 调用时机：loadGame / markLoaded（和 syncNsfwFromLocalStorage 同步）。
   */
  function syncAllSettingsFromLocalStorage(): void {
    // Heartbeat
    try {
      const raw = localStorage.getItem('aga_heartbeat_settings');
      if (raw) {
        const parsed = JSON.parse(raw) as { enabled?: boolean; period?: number };
        if (typeof parsed.enabled === 'boolean') setValue('世界.状态.心跳.配置.enabled', parsed.enabled);
        if (typeof parsed.period === 'number' && parsed.period > 0) setValue('世界.状态.心跳.配置.period', parsed.period);
      }
    } catch { /* no-op */ }

    // Action Options
    try {
      const raw = localStorage.getItem('aga_action_options_settings');
      if (raw) {
        const parsed = JSON.parse(raw) as { mode?: string; pace?: string; customPrompt?: string };
        if (parsed.mode === 'action' || parsed.mode === 'story') setValue('系统.actionOptions.mode', parsed.mode);
        if (parsed.pace === 'fast' || parsed.pace === 'slow') setValue('系统.actionOptions.pace', parsed.pace);
        if (typeof parsed.customPrompt === 'string') setValue('系统.actionOptions.customPrompt', parsed.customPrompt);
      }
    } catch { /* no-op */ }

    // CoT settings
    try {
      const raw = localStorage.getItem('aga_cot_settings');
      if (raw) {
        const parsed = JSON.parse(raw) as { enabled?: boolean; judgeEnabled?: boolean; injectStep2?: boolean; ringSize?: number };
        if (typeof parsed.enabled === 'boolean') setValue('系统.设置.cot.enabled', parsed.enabled);
        if (typeof parsed.judgeEnabled === 'boolean') setValue('系统.设置.cot.judgeEnabled', parsed.judgeEnabled);
        if (typeof parsed.injectStep2 === 'boolean') setValue('系统.设置.cot.injectStep2', parsed.injectStep2);
        if (typeof parsed.ringSize === 'number' && parsed.ringSize >= 1) setValue('系统.设置.cot.reasoningRingSize', parsed.ringSize);
      }
    } catch { /* no-op */ }

    // Body polish
    try {
      const raw = localStorage.getItem('aga_body_polish_settings');
      if (raw) {
        const parsed = JSON.parse(raw) as { enabled?: boolean };
        if (typeof parsed.enabled === 'boolean') setValue('系统.设置.bodyPolish', parsed.enabled);
      }
    } catch { /* no-op */ }

    // Presence partition
    try {
      const raw = localStorage.getItem('aga_presence_settings');
      if (raw) {
        const parsed = JSON.parse(raw) as { presenceEnabled?: boolean };
        if (typeof parsed.presenceEnabled === 'boolean') setValue('系统.设置.social.presenceEnabled', parsed.presenceEnabled);
      }
    } catch { /* no-op */ }

    // Image generation
    try {
      const raw = localStorage.getItem('aga_image_gen_settings');
      if (raw) {
        const parsed = JSON.parse(raw) as { enabled?: boolean };
        if (typeof parsed.enabled === 'boolean') setValue('系统.扩展.image.enabled', parsed.enabled);
      }
    } catch { /* no-op */ }

    // Prompt settings — ensure defaults exist in state tree
    // (PromptPanel reads/writes to 系统.设置.prompt; SystemPromptBuilder reads it)
    if (!get('系统.设置.prompt')) {
      setValue('系统.设置.prompt', {
        perspective: '第二人称',
        wordCountRequirement: 650,
        storyStyle: 'general',
        enableNoControl: true,
        enableActionOptions: true,
        actionOptionsMode: 'action',
        actionPace: 'fast',
        customSystemPrompt: '',
      });
    }

    // Heroine plan — ensure default structure exists
    if (!get('元数据.女主规划')) {
      setValue('元数据.女主规划', {
        stageProgression: [],
        heroineEntries: [],
        interactionEvents: [],
        scenePlans: [],
      });
    }
  }

  /** Export a plain snapshot of the state tree */
  function toSnapshot(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(tree.value)) as Record<string, unknown>;
  }

  /**
   * 从 UI 层写入状态树 — 用于 SchemaForm / 内联编辑等交互
   *
   * 2026-04-13：改为优先调用 StateManager.set()（如已 linked），原因：
   * 1. StateManager.set 使用 lodash `_set` 做路径写入，正确处理嵌套创建、
   *    数组索引、过滤器路径（[名称=X] 语法），比手写的 tree 行走更健壮
   * 2. 内部走 `cloneDeep` 写入，避免 UI 层传入的对象与状态树产生引用混叠
   *    （之前 setValue 直接赋对象引用，导致后续 UI 编辑改到快照里的对象也
   *    污染主状态树）
   * 3. 触发 recordChange + 'state:changed' 事件，变更可被回放/回滚/调试面板捕获
   * 4. 响应式链路与 AI 命令写入完全一致，消除 UI/AI 两路径的微妙差异
   *
   * 未 linked 时走降级路径（仅测试场景），行为与旧实现一致。
   */
  function setValue(path: StatePath, value: unknown): void {
    if (_linkedStateManager) {
      _linkedStateManager.set(path, value, 'user');
      return;
    }

    // 降级：手写 tree 行走（仅在 StateManager 未注入的单元测试场景）
    const segments = path.split('.');
    let current: Record<string, unknown> = tree.value;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (!(seg in current) || typeof current[seg] !== 'object' || current[seg] === null) {
        current[seg] = {};
      }
      current = current[seg] as Record<string, unknown>;
    }
    current[segments[segments.length - 1]] = value;
  }

  /**
   * 将 Pinia store 的 tree 与 StateManager 的 reactive 状态树共享同一对象引用。
   * 调用后，StateManager 对状态树的任何写入（set/push/delete 等）
   * 都会通过同一个 reactive proxy 直接反映到 Vue 响应式系统中，
   * 彻底消除"双轨"不同步问题。
   *
   * 必须在 createPinia() 之后、app.mount() 之前调用一次。
   */
  function linkStateManager(sm: StateManager): void {
    // 保存引用，供 loadGame() 调用 sm.loadTree() 就地更新（而非替换 ref）
    _linkedStateManager = sm;
    // sm.getTree() 返回 reactive({}) proxy，直接赋给 tree.value，
    // Vue 3 的 ref 不会对已经是 reactive 的对象再做包装，保持同一引用。
    tree.value = sm.getTree() as GameStateTree;

    // StateManager 的 set/push/delete 等就地修改 reactive proxy，但不会
    // 改变 tree ref 本身的引用。useValue 的 computed 通过 `void store.tree`
    // 依赖 tree ref，却无法感知深层的数组 push 等变化。
    // triggerRef 强制所有依赖 tree ref 的 computed 重新求值。
    eventBus.on('engine:state-changed', () => {
      triggerRef(tree);
    });
  }

  /**
   * 注入 BehaviorRunner（main.ts 启动时调用，与 linkStateManager 同模式）。
   * 结构化类型（只要求 runOnGameLoad）避免 store 依赖 BehaviorRunner 具体类。
   */
  function linkBehaviorRunner(runner: { runOnGameLoad(sm: StateManager): void }): void {
    _linkedBehaviorRunner = runner;
  }

  /** Clear all game state */
  function clearGame(): void {
    if (_linkedStateManager) {
      // 就地清空 reactive proxy，保持 tree.value 与 stateManager.state 的引用不变。
      // 之前 `tree.value = {}` 会替换引用，导致后续 loadGame() 写入 stateManager
      // 但 tree.value 仍指向旧的空对象 —— UI 永远看不到数据。
      _linkedStateManager.clear();
    } else {
      tree.value = {};
    }
    isGameLoaded.value = false;
    activePackId.value = null;
    activeProfileId.value = null;
    activeSlotId.value = null;
  }

  return {
    isGameLoaded,
    activePackId,
    activeProfileId,
    activeSlotId,
    tree,
    packName,
    characterName,
    currentLocation,
    gameTime,
    roundNumber,
    vitalHealth,
    vitalEnergy,
    statusEffects,
    reputation,
    talents,
    get,
    loadGame,
    markLoaded,
    toSnapshot,
    setValue,
    linkStateManager,
    linkBehaviorRunner,
    clearGame,
  };
});
