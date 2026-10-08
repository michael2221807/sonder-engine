// structuredClone polyfill — must run before any import that touches idb-adapter.
// Safe for AGA: persisted data is exclusively JSON-compatible (no Date/Map/Set/cycle).
// If a future module stores non-JSON-safe values, replace with a proper polyfill.
if (typeof globalThis.structuredClone !== 'function') {
  (globalThis as Record<string, unknown>).structuredClone = <T>(val: T): T =>
    JSON.parse(JSON.stringify(val)) as T;
}

/**
 * 应用入口 — 引擎初始化序列
 *
 * 启动流程（按依赖顺序）：
 * 1. Vue + Pinia + Router
 * 2. API 配置加载 → AIService
 * 3. 持久化层（ProfileManager → SaveManager）
 * 4. 配置系统（Registry + Store + Resolver）
 * 5. Game Pack 加载
 * 6. Prompt 引擎（PromptRegistry + TemplateEngine + PromptAssembler + ResponseParser）
 * 7. StateManager / CommandExecutor / BehaviorRunner / CharacterInitPipeline
 * 8. PromptStorage / VectorStore / BackupService（M5 备份与 Engram 持久化）
 * 9. Action Queue 恢复
 * 10. provide → 挂载
 */
import { createApp, watch } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './ui/router';
import { i18n, loadLocaleMessages } from './ui/i18n';
import './ui/styles/tokens.css';
import './ui/styles/forms.css';
import './ui/styles/mobile.css';

// Apply persisted font-size × ui-scale before any component renders so the
// user's preference survives page refresh regardless of which route they
// land on. SettingsPanel owns the source of truth; this is a cold-boot
// replay of what SettingsPanel.applyRootMetrics does.
(function applyPersistedRootMetrics(): void {
  try {
    const raw = localStorage.getItem('aga_user_settings');
    const scaleRaw = localStorage.getItem('aga_ui_scale');
    const parsed = raw ? (JSON.parse(raw) as { fontSize?: number; themeAccent?: string }) : {};
    const fontPx = typeof parsed.fontSize === 'number' ? parsed.fontSize : 14;
    const scalePct = scaleRaw ? Number(scaleRaw) : 100;
    const rootPx = (fontPx * scalePct) / 100;
    document.documentElement.style.fontSize = `${rootPx}px`;
    document.documentElement.style.setProperty('--base-font-size', `${fontPx}px`);
    document.documentElement.style.setProperty('--narrative-font-size', `${fontPx}px`);
    document.documentElement.style.setProperty('--ui-scale', `${scalePct}%`);
    if (typeof parsed.themeAccent === 'string') {
      document.documentElement.style.setProperty('--color-primary', parsed.themeAccent);
    }
  } catch { /* localStorage unavailable — skip silently */ }
})();

import { eventBus } from './engine/core/event-bus';
import { StateManager } from './engine/core/state-manager';
import { CommandExecutor, composePushGuards, schemaNumberBounds, schemaDeclaresArray, schemaDeclaresPath } from './engine/core/command-executor';
import { buildMemoryPushDedupGuard } from './engine/social/memory-dedup';
import { buildRelationshipMergeGuard } from './engine/social/relationship-merge-guard';
import { BehaviorRunner } from './engine/behaviors/behavior-runner';
import { CharacterInitPipeline } from './engine/pipeline/sub-pipelines/character-init';
import { MemorySummaryPipeline } from './engine/pipeline/sub-pipelines/memory-summary';
import { MidTermRefinePipeline } from './engine/pipeline/sub-pipelines/mid-term-refine';
import { CharacterVectorProposePipeline } from './engine/pipeline/sub-pipelines/character-vector-propose';
import { LongTermCompactPipeline } from './engine/pipeline/sub-pipelines/long-term-compact';
import { WorldHeartbeatPipeline } from './engine/pipeline/sub-pipelines/world-heartbeat';
import { NpcGenerationPipeline } from './engine/pipeline/sub-pipelines/npc-generation';
import { PrivacyProfileRepairPipeline } from './engine/pipeline/sub-pipelines/privacy-profile-repair';
import { FieldRepairPipeline } from './engine/pipeline/sub-pipelines/field-repair';
import { PlotEvaluationPipeline } from './engine/plot/plot-evaluation-pipeline';
import { PlotDecomposer } from './engine/plot/plot-decomposer';
import { PlotReviser } from './engine/plot/plot-reviser';
import { NpcMemorySummarizer } from './engine/social/npc-memory-summarizer';
import { ImageService } from './engine/image/image-service';
import { ImageProviderRegistry } from './engine/image/provider-registry';
import { NovelAIImageProvider } from './engine/image/providers/novelai';
import { OpenAIImageProvider } from './engine/image/providers/openai';
import { SDWebUIImageProvider } from './engine/image/providers/sd-webui';
import { ComfyUIImageProvider } from './engine/image/providers/comfyui';
import { CivitaiImageProvider } from './engine/image/providers/civitai';
import { VolcengineImageProvider } from './engine/image/providers/volcengine';
import { TtsService } from './engine/tts/tts-service';
import { TtsProviderRegistry } from './engine/tts/provider-registry';
import { CosyVoiceProvider } from './engine/tts/providers/cosyvoice';
import { DoubaoTtsProvider } from './engine/tts/providers/doubao';
import { SttService } from './engine/stt/stt-service';
import { SttProviderRegistry } from './engine/stt/provider-registry';
import { CosyVoiceSttProvider } from './engine/stt/providers/cosyvoice';
import { DoubaoSttProvider } from './engine/stt/providers/doubao';
import { providerCatalog, measureConnectionTest } from './engine/providers';
import { migrateImageState } from './engine/image/save-migration';
import { NpcChatPipeline } from './engine/pipeline/sub-pipelines/npc-chat';
import { DEFAULT_ENGINE_PATHS } from './engine/pipeline/types';
import { TimeService, gameCalendar } from './engine/behaviors/time-service';
import { NpcDedupModule } from './engine/behaviors/npc-dedup';
import { NpcMainRoundUpdateModule } from './engine/behaviors/npc-main-round-update';
import { NpcDemotionModule } from './engine/behaviors/npc-demotion';
import { NarrativeEnvelopeRepairModule } from './engine/behaviors/narrative-envelope-repair';
import { MemoryCompilerModule } from './engine/behaviors/memory-compiler';
import { ComputedFieldsModule } from './engine/behaviors/computed-fields';
import { EffectLifecycleModule } from './engine/behaviors/effect-lifecycle';
import { ThresholdTriggersModule } from './engine/behaviors/threshold-triggers';
import { NpcBehaviorModule } from './engine/behaviors/npc-behavior';
import { ValidationRepairModule } from './engine/behaviors/validation-repair';
import { ContentFilterModule } from './engine/behaviors/content-filter';
import { CrossRefSyncModule } from './engine/behaviors/cross-ref-sync';
import { GameOrchestrator } from './engine/core/game-orchestrator';
import { MemoryManager } from './engine/memory/memory-manager';
import { MemoryRetriever } from './engine/memory/memory-retriever';
import { EngramManager } from './engine/memory/engram/engram-manager';
import { EngramEditor } from './engine/memory/engram/engram-editor';
import { useEngineStateStore } from './engine/stores/engine-state';
import { AgaPlotVectorAdapter } from './features/plot-vector/aga-adapter';
import { VectorBoardAccess } from './features/plot-vector/board-access';
import { parseNativeRules } from './features/plot-vector/native-input';
import { parseSupplyRules, warmSupplyRatings } from './features/plot-vector/supply';
import { parseVectorPromptPolicy } from './features/plot-vector/prompt-policy';
import type { ComputedFieldConfig, ThresholdTriggerConfig, IntegrityRule, EffectLifecycleConfig, NpcBehaviorConfig, ContentFilterConfig } from './engine/types';

import { requestPersistentStorage } from './engine/persistence/idb-adapter';
import { GameCardImportService } from './engine/export/game-card-import-service';
import { GitHubSyncService } from './engine/sync/github-sync';
import { LanSyncService } from './engine/sync/lan-sync';
import { AssistantService } from './engine/services/assistant/assistant-service';
import { PayloadApplier } from './engine/services/assistant/payload-applier';
import { PayloadValidator } from './engine/services/assistant/payload-validator';
import { WorldBuilderService } from './engine/services/world-builder/world-builder-service';
import { InMemoryConversationStore } from './engine/services/assistant/conversation-store';
import { UnifiedRetriever } from './engine/memory/engram/unified-retriever';
import { Embedder } from './engine/memory/engram/embedder';
import { Reranker } from './engine/memory/engram/reranker';
import { useEngramDebugStore } from './engine/stores/engram-debug';

import { useActionQueueStore } from './engine/stores/engine-action-queue';
import { usePromptDebugStore } from './engine/stores/engine-prompt';
import { createAiStack } from './bootstrap/ai-stack';
import { createPersistenceStack } from './bootstrap/persistence-stack';
import { loadPackAndMigrations } from './bootstrap/pack-and-migrations';
import { createPromptStack } from './bootstrap/prompt-stack';

async function bootstrap(): Promise<void> {
  const app = createApp(App);
  const pinia = createPinia();
  app.use(pinia);
  app.use(router);
  app.use(i18n);

  // Pre-load non-default locale messages before first render
  try {
    await loadLocaleMessages(i18n.global.locale.value);
  } catch (err) {
    console.warn('[Bootstrap] Locale load failed, falling back to zh-CN:', err);
    i18n.global.locale.value = 'zh-CN';
  }

  const { aiService } = createAiStack();

  const { profileManager, saveManager, configRegistry, configStore, configResolver, promptStorage, vectorStore, customPresetStore, imageAssetCacheForBackup, worldBookStorage, backupService, gameCardExportService } = await createPersistenceStack();

  const pack = await loadPackAndMigrations({ saveManager, customPresetStore });

  const { promptRegistry, responseParser, promptAssembler } = createPromptStack({ pack, worldBookStorage });

  const stateManager = new StateManager();

  // §11.4: 从 pack.stateSchema 动态提取顶层 properties 作为 CommandExecutor 的路径根白名单
  // 这能让 AI 生成的写入路径在运行时被检测为未知根段（console.warn + toast）
  // 零硬编码：pack 更换或 schema 扩充时自动适配
  const schemaRoots: string[] | null = pack
    ? Object.keys(
        ((pack.stateSchema as { properties?: Record<string, unknown> }).properties) ?? {},
      )
    : null;
  const memoryFieldName = DEFAULT_ENGINE_PATHS.npcFieldNames.memory;
  // Push 守卫组合：.记忆 近似去重（抑制）+ 社交.关系 同名 NPC 融合（合并进已有条目，
  // 不丢数据、不打断回合 — 见 relationship-merge-guard.ts / npc-merge.ts 的合并策略）
  const pushDedupGuard = composePushGuards(
    buildMemoryPushDedupGuard(memoryFieldName),
    buildRelationshipMergeGuard(
      stateManager,
      DEFAULT_ENGINE_PATHS.relationships,
      DEFAULT_ENGINE_PATHS.npcFieldNames,
    ),
  );
  // Numeric ranges the pack schema declares (e.g. an affinity of -100~100) bound set/add writes.
  const commandExecutor = new CommandExecutor(stateManager, schemaRoots, pushDedupGuard,
    pack ? (path => schemaNumberBounds(pack.stateSchema, path)) : undefined,
    pack ? (path => schemaDeclaresArray(pack.stateSchema, path)) : undefined,
    pack ? (path => schemaDeclaresPath(pack.stateSchema, path)) : undefined);

  const behaviorRunner = new BehaviorRunner();

  // One calendar for every module that reads the game clock. TimeService once got only 年/月/日, so it carried
  // fallback `hour`/`minute` fields while the real 分钟 grew without end and EffectLifecycle (which read 分钟)
  // expired every new status at round end (2026-09-26, PO D1).
  const calendar = gameCalendar(DEFAULT_ENGINE_PATHS);

  // ── #21: 注册行为模块 ──
  // TimeService：推进游戏内时间进位（分钟→小时→日→月→年 归一化）
  behaviorRunner.register(new TimeService(calendar, DEFAULT_ENGINE_PATHS.characterAge));

  // NpcDedupModule：社交.关系 同名 NPC 兜底融合（onRoundEnd + onGameLoad）
  // push 级守卫（relationship-merge-guard）覆盖 CommandExecutor 路径；此模块
  // 兜住整数组 set（助手 replace-array / GameVariablePanel 原始 JSON）与历史脏存档
  behaviorRunner.register(new NpcDedupModule(
    DEFAULT_ENGINE_PATHS.relationships,
    DEFAULT_ENGINE_PATHS.npcFieldNames,
  ));

  // NpcMainRoundUpdateModule：记下主回合最后一次更新每位 NPC 的回合（心跳「遗忘回合数」按它算），
  // 读档时给还没有记录的 NPC 补上当前回合。排在去重之后：给融合后的列表记。
  behaviorRunner.register(new NpcMainRoundUpdateModule(
    DEFAULT_ENGINE_PATHS.relationships,
    DEFAULT_ENGINE_PATHS.roundNumber,
    DEFAULT_ENGINE_PATHS.npcFieldNames,
  ));

  // NpcDemotionModule：回合结束时，超过「NPC 降级阈值」回合没被主回合更新的「重点」（或没写类型的）NPC 降为普通（demo runNpcMaintenance）。
  // 依赖上一个模块记下的「上次主回合更新回合」。
  behaviorRunner.register(new NpcDemotionModule(
    DEFAULT_ENGINE_PATHS.relationships,
    DEFAULT_ENGINE_PATHS.roundNumber,
    DEFAULT_ENGINE_PATHS.npcDemotionThreshold,
    DEFAULT_ENGINE_PATHS.npcTypeKey,
    DEFAULT_ENGINE_PATHS.npcTypeExclude,
    DEFAULT_ENGINE_PATHS.npcFieldNames,
  ));

  // ── #3: 将 Pinia tree 绑定到 StateManager 的 reactive 对象 ──
  // 必须在 createPinia() 之后、任何 UI 读取状态之前调用。
  // 绑定后 StateManager 的所有写操作自动反映到 Vue 响应式系统。
  const engineStateStore = useEngineStateStore();
  engineStateStore.linkStateManager(stateManager);
  // 读档时分发 onGameLoad 行为钩子（npc-dedup 融合 / effect-lifecycle 清理 /
  // validation-repair 修复）——2026-07-05 前这些钩子只在创角后触发，真实读档从不执行
  engineStateStore.linkBehaviorRunner(behaviorRunner);

  // ── #2: 实例化记忆服务 ──
  //
  // 2026-04-11 重构（四层记忆系统）：
  // - shortTermCapacity = 5（降低自 8，match demo + design note）
  // - midTermRefineThreshold = 25（in-place 精炼阈值）
  // - longTermSummaryThreshold = 50（worldview evolution 阈值）
  // - 隐式中期和短期 1:1 配对，由 MemoryManager.shiftAndPromoteOldest 同步 shift
  // - MemoryRetriever 现在依赖 MemoryManager 做隐式中期的相关角色过滤
  const memoryPathConfig = {
    shortTermPath: DEFAULT_ENGINE_PATHS.shortTermMemory,
    midTermPath: DEFAULT_ENGINE_PATHS.memoryMidTerm,
    longTermPath: DEFAULT_ENGINE_PATHS.memoryLongTerm,
    implicitMidTermPath: DEFAULT_ENGINE_PATHS.implicitMidTermMemory,
    semanticMemoryPath: DEFAULT_ENGINE_PATHS.engramMemory,
    // 默认值 —— 可被 localStorage `aga_memory_settings` 运行时覆盖（SettingsPanel UI）
    shortTermCapacity: 5,
    midTermRefineThreshold: 25,
    longTermSummaryThreshold: 50,
    longTermSummarizeCount: 50,
    midTermKeep: 0,
    longTermCap: 30,
  };
  const memoryManager = new MemoryManager(stateManager, memoryPathConfig);
  // NarrativeEnvelopeRepairModule：读档时修好存成 JSON 外壳（`{"text":"…`）的回合正文、短期记忆与收藏楼层快照（2026-10-03）
  behaviorRunner.register(new NarrativeEnvelopeRepairModule(
    DEFAULT_ENGINE_PATHS.narrativeHistory, memoryPathConfig.shortTermPath, DEFAULT_ENGINE_PATHS.bookmarkedRounds));
  const memoryRetriever = new MemoryRetriever(memoryPathConfig, memoryManager);

  // MemoryCompilerModule：在上下文组装阶段将结构化记忆注入 prompt 变量
  behaviorRunner.register(new MemoryCompilerModule(memoryManager));

  // ── GAP_AUDIT §G1: 注册剩余行为模块（读 pack.rules 的 JSON 配置） ──
  //
  // 注册顺序依赖：
  // 1. TimeService 必须在 EffectLifecycle 之前（effect 的过期判断依赖已归一化的时间）
  // 2. ComputedFields 宜在 TimeService 之后（衍生字段可能引用时间相关值）
  // 3. ValidationRepair 最后，在其他模块可能产生的"修复机会"之后执行收尾校验
  //
  // 所有模块 config 来自 Game Pack 的 rules/*.json，
  // 不存在时模块不注册（引擎不强制依赖 pack 内容）。
  if (pack) {
    const rules = pack.rules as Record<string, unknown>;

    // ComputedFields — onCreation / onRoundEnd / onLoad 计算派生字段
    const computedConfig = rules['computedFields'] as { fields?: ComputedFieldConfig[] } | undefined;
    if (computedConfig?.fields?.length) {
      behaviorRunner.register(new ComputedFieldsModule(computedConfig.fields));
    }

    // EffectLifecycle — onRoundEnd / onGameLoad 清理过期 buff/debuff
    const effectConfig = rules['effectLifecycle'] as EffectLifecycleConfig | undefined;
    if (effectConfig?.effectsPath && effectConfig.effectSchema) {
      const effectLifecycle = new EffectLifecycleModule(effectConfig, calendar);
      behaviorRunner.register(effectLifecycle);
      // A status written by any flow (sub-pipelines, the assistant) starts on the game clock too (PO G1).
      commandExecutor.observeBatches(changeLog => effectLifecycle.stampWritten(stateManager, changeLog));
    }

    // ThresholdTriggers — onRoundEnd / onGameLoad 检查阈值触发事件
    const triggerConfig = rules['thresholdTriggers'] as { triggers?: ThresholdTriggerConfig[] } | undefined;
    if (triggerConfig?.triggers?.length) {
      behaviorRunner.register(new ThresholdTriggersModule(triggerConfig.triggers));
    }

    // NpcBehavior — afterCommands 钩子中处理玩家移动时的 NPC 跟随/留守
    const npcConfig = rules['npcBehavior'] as NpcBehaviorConfig | undefined;
    if (npcConfig?.npcTypes) {
      behaviorRunner.register(new NpcBehaviorModule(
        npcConfig,
        {
          playerLocation: DEFAULT_ENGINE_PATHS.playerLocation,
          npcList: DEFAULT_ENGINE_PATHS.npcList, // 已修正为 '社交.关系'
        },
      ));
    }

    // ContentFilter — onContextAssembly 钩子中按 nsfwMode 等评级开关剥离 prompt 中的敏感片段
    const filterConfig = rules['contentFilter'] as ContentFilterConfig | undefined;
    if (filterConfig?.contentRatings) {
      behaviorRunner.register(new ContentFilterModule(filterConfig));
    }

    // CrossRefSync — afterCommands 钩子中维护 NPC.位置 ↔ 地点.NPC 列表双向一致
    const syncConfig = rules['crossRefSync'] as { rules?: IntegrityRule[] } | undefined;
    if (syncConfig?.rules?.length) {
      behaviorRunner.register(new CrossRefSyncModule(syncConfig.rules));
    }

    // ValidationRepair — 最后注册，在其他模块执行完后做收尾的 schema 校验与字段修复
    // 不依赖 rules/*.json，直接读 pack.stateSchema
    behaviorRunner.register(new ValidationRepairModule(pack.stateSchema));
  }

  // E.4: 使用真实 EngramManager 代替之前的 stub
  // 配置从 localStorage (aga_engram_config) 读取，默认 enabled=false。
  // 用户在 Settings → Engram 开关后，下一回合立即生效，无需重启。
  //
  // getActiveSlot: Engram 向量存储需要 profileId+slotId 构建 IndexedDB key。
  // 这两个值是引擎元数据（存在于 Pinia store），不在游戏状态树中。
  // 旧版本从 stateManager.get('元数据.profileId') 读取 —— 该路径从未被写入，
  // 导致 vectorizeAsync 永远 early return，embedding API 从不被调用。
  const getActiveSlot = () => {
    const p = engineStateStore.activeProfileId;
    const s = engineStateStore.activeSlotId;
    return p && s ? { profileId: p, slotId: s } : null;
  };
  const engramManager = new EngramManager(
    aiService,
    {
      npcNameField: DEFAULT_ENGINE_PATHS.npcFieldNames.name,
      npcTypeField: DEFAULT_ENGINE_PATHS.npcFieldNames.type,
      npcTypeKey: DEFAULT_ENGINE_PATHS.npcTypeKey,
      // M-3: NPC entity summary source fields (生平+外貌), sourced from the central path config
      // so a future pack-level npcFieldNames override flows through to EntityBuilder.
      npcBackgroundField: DEFAULT_ENGINE_PATHS.npcFieldNames.background,
      npcAppearanceField: DEFAULT_ENGINE_PATHS.npcFieldNames.appearance,
      npcDescriptionField: DEFAULT_ENGINE_PATHS.npcFieldNames.description,
    },
    getActiveSlot,
  );

  // Story 1: EngramEditor for user-driven entity/edge CRUD
  const engramEditor = new EngramEditor(stateManager, engramManager, {
    engramMemory: DEFAULT_ENGINE_PATHS.engramMemory,
    roundNumber: DEFAULT_ENGINE_PATHS.roundNumber,
    relationships: DEFAULT_ENGINE_PATHS.relationships,
    locations: DEFAULT_ENGINE_PATHS.locations,
    npcNameField: DEFAULT_ENGINE_PATHS.npcFieldNames.name,
    npcTypeField: DEFAULT_ENGINE_PATHS.npcFieldNames.type,
    npcTypeExclude: DEFAULT_ENGINE_PATHS.npcTypeExclude,
    locationNameField: DEFAULT_ENGINE_PATHS.locationFieldNames.name,
  });

  // E.2/E.3: UnifiedRetriever 实例（hybrid 模式时由 ContextAssemblyStage 使用）
  const embedder = new Embedder(aiService);
  const reranker = new Reranker(aiService);
  const engramDebugStore = useEngramDebugStore();
  const unifiedRetriever = new UnifiedRetriever(
    vectorStore,
    embedder,
    reranker,
    () => {
      const cfg = engramManager.getConfig();
      return { embedding: cfg.embedding, rerank: cfg.rerank, shortTermWindow: cfg.shortTermWindow, maxCandidates: cfg.maxCandidates };
    },
    engramDebugStore,
    getActiveSlot,
  );

  // CharacterInitPipeline is created after GameOrchestrator (below) to enable
  // EnhancedOpeningPipeline injection which requires orchestrator.createStagesForOpening().
  let characterInitPipeline: CharacterInitPipeline | null = null;

  // ── GAP_AUDIT §G2: 实例化 4 个后置子管线 ──
  // 这些管线由 GameOrchestrator.runRound 在主回合结束后按条件触发：
  // - MemorySummary: 短期记忆满 → 总结为一条中期记忆条目
  // - MidTermRefine: 中期记忆满 → 精炼为长期记忆条目
  // - WorldHeartbeat: 到达心跳周期 → 为候选 NPC 更新状态
  // - NpcGeneration: 玩家移动到新地点 → 生成 1-3 个 NPC
  let memorySummaryPipeline: MemorySummaryPipeline | undefined;
  let midTermRefinePipeline: MidTermRefinePipeline | undefined;
  let characterVectorProposePipeline: CharacterVectorProposePipeline | undefined;
  let longTermCompactPipeline: LongTermCompactPipeline | undefined;
  let worldHeartbeatPipeline: WorldHeartbeatPipeline | undefined;
  let npcGenerationPipeline: NpcGenerationPipeline | undefined;
  let privacyRepairPipeline: PrivacyProfileRepairPipeline | undefined;
  let fieldRepairPipeline: FieldRepairPipeline | undefined;
  // Assigned when the orchestrator is built; step-3 field repair asks it for environment-ability repairs.
  let plotVectorAdapter: AgaPlotVectorAdapter | undefined;
  let npcMemSummarizer: NpcMemorySummarizer | undefined;

  if (pack) {
    memorySummaryPipeline = new MemorySummaryPipeline(
      aiService,
      responseParser,
      promptAssembler,
      memoryManager,
      pack,
      stateManager, // 2026-04-11: worldview evolution 需要读游戏状态概要
      DEFAULT_ENGINE_PATHS, // 2026-04-11 CR M-09: 路径从 config 读，不再硬编码
    );
    midTermRefinePipeline = new MidTermRefinePipeline(
      aiService,
      responseParser,
      promptAssembler,
      memoryManager,
      pack,
    );
    // Character Vectors (R2 second half, 2026-09-06): the world proposes per-NPC vectors after
    // the mid-term refine and every CHARACTER_VECTOR_PROPOSE_INTERVAL rounds.
    characterVectorProposePipeline = new CharacterVectorProposePipeline(
      aiService,
      promptAssembler,
      stateManager,
      memoryManager,
      pack,
      DEFAULT_ENGINE_PATHS,
    );
    longTermCompactPipeline = new LongTermCompactPipeline(
      aiService,
      responseParser,
      promptAssembler,
      memoryManager,
      pack,
    );
    worldHeartbeatPipeline = new WorldHeartbeatPipeline(
      stateManager,
      commandExecutor,
      aiService,
      responseParser,
      promptAssembler,
      pack,
      DEFAULT_ENGINE_PATHS,
      engramManager,
    );
    npcGenerationPipeline = new NpcGenerationPipeline(
      stateManager,
      commandExecutor,
      aiService,
      responseParser,
      promptAssembler,
      pack,
      DEFAULT_ENGINE_PATHS,
    );
    // Phase 4 (2026-04-19): Body polish was promoted from sub-pipeline to
    // `BodyPolishStage` inside the main pipeline (see game-orchestrator.ts).
    // The old `BodyPolishPipeline` sub-pipeline construction was removed from here.

    // Sprint Social-5: NPC memory summarizer
    npcMemSummarizer = new NpcMemorySummarizer(
      stateManager,
      aiService,
      promptAssembler,
      DEFAULT_ENGINE_PATHS,
    );

    privacyRepairPipeline = new PrivacyProfileRepairPipeline(
      stateManager,
      commandExecutor,
      aiService,
      responseParser,
      promptAssembler,
      pack,
      DEFAULT_ENGINE_PATHS,
    );

    fieldRepairPipeline = new FieldRepairPipeline(
      stateManager,
      commandExecutor,
      aiService,
      responseParser,
      promptAssembler,
      memoryRetriever,
      pack,
      DEFAULT_ENGINE_PATHS,
      // Step 3 also regenerates abilities that failed: environment tags and one item/talent/status per round (plot vector, when enabled).
      () => plotVectorAdapter?.abilityRepairTask() ?? Promise.resolve(null),
    );
  }

  // Sprint Plot-1 P4: PlotEvaluationPipeline — 剧情节点评估
  let plotEvaluationPipeline: PlotEvaluationPipeline | undefined;
  let plotDecomposer: PlotDecomposer | undefined;
  let plotReviser: PlotReviser | undefined;
  if (pack) {
    plotEvaluationPipeline = new PlotEvaluationPipeline(
      stateManager,
      DEFAULT_ENGINE_PATHS,
    );
    plotDecomposer = new PlotDecomposer(
      aiService,
      responseParser,
      stateManager,
      pack,
      DEFAULT_ENGINE_PATHS,
      promptAssembler,
    );
    // Plot Revise & Extend epic — AI revision of an existing thread's pending region
    plotReviser = new PlotReviser(
      plotDecomposer,
      stateManager,
      pack,
      DEFAULT_ENGINE_PATHS,
    );
  }

  // §7.2 NPC 私聊子管线 — 独立于主回合的异步 1:1 对话
  // 通过 app.provide 暴露给 UI 层（RelationshipPanel / NpcChatModal）
  let npcChatPipeline: NpcChatPipeline | null = null;
  if (pack) {
    npcChatPipeline = new NpcChatPipeline(
      stateManager,
      commandExecutor,
      aiService,
      responseParser,
      promptAssembler,
      pack,
      DEFAULT_ENGINE_PATHS,
      memoryManager,
      engramManager,
    );
  }

  // ── Image subsystem bootstrap (must be before orchestrator which references imageService) ──
  const imageProviderRegistry = new ImageProviderRegistry();
  imageProviderRegistry.register('novelai', (c) => new NovelAIImageProvider(c.endpoint, c.apiKey, c.model));
  imageProviderRegistry.register('openai', (c) => new OpenAIImageProvider(c.endpoint, c.apiKey, c.model));
  imageProviderRegistry.register('sd_webui', (c) => new SDWebUIImageProvider(c.endpoint, c.apiKey, c.model));
  imageProviderRegistry.register('comfyui', (c) => new ComfyUIImageProvider(c.endpoint, c.apiKey, c.model));
  imageProviderRegistry.register('civitai', (c) => new CivitaiImageProvider(c.endpoint, c.apiKey, c.model));
  imageProviderRegistry.register('volcengine', (c) => new VolcengineImageProvider(c.endpoint, c.apiKey, c.model));

  const imageService = new ImageService(
    stateManager,
    aiService,
    promptAssembler,
    imageProviderRegistry,
    DEFAULT_ENGINE_PATHS,
  );

  // Pass pack-level transformer defaults to ImageService for i18n-aware prompt text
  if (pack?.transformerDefaults) {
    imageService.setTransformerDefaults(
      pack.transformerDefaults as import('./engine/image/transformer-presets').TransformerDefaultsData,
    );
  }

  migrateImageState(stateManager);

  // ── TTS subsystem bootstrap (before orchestrator which references ttsService) ──
  const ttsProviderRegistry = new TtsProviderRegistry();
  ttsProviderRegistry.register('cosyvoice', (c) => new CosyVoiceProvider(c.endpoint, c.apiKey, c.routingPath));
  ttsProviderRegistry.register('doubao', (c) => new DoubaoTtsProvider(c.endpoint, c.apiKey, c.routingPath, c.credentials));
  const ttsService = new TtsService(aiService, ttsProviderRegistry);

  // ── STT subsystem bootstrap (语音输入;用户触发,不进 orchestrator subPipelines) ──
  const sttProviderRegistry = new SttProviderRegistry();
  sttProviderRegistry.register('cosyvoice', (c) => new CosyVoiceSttProvider(c.endpoint, c.apiKey, c.routingPath));
  sttProviderRegistry.register('doubao', (c) => new DoubaoSttProvider(c.endpoint, c.apiKey, c.routingPath, c.credentials));
  const sttService = new SttService(aiService, sttProviderRegistry);

  // ── Provider catalog wiring (epic P0) ──
  // 1. Fail-fast pairing check: every image/tts/stt descriptor must have a
  //    registered factory and vice versa — a mismatch is a wiring bug caught at boot.
  for (const [category, registry] of [
    ['image', imageProviderRegistry],
    ['tts', ttsProviderRegistry],
    ['stt', sttProviderRegistry],
  ] as const) {
    const catalogIds = providerCatalog.byCategory(category).map((d) => d.id).sort();
    const factoryIds = [...registry.registeredBackends].sort();
    if (JSON.stringify(catalogIds) !== JSON.stringify(factoryIds)) {
      throw new Error(
        `[bootstrap] provider catalog/registry mismatch for "${category}": ` +
        `catalog=[${catalogIds.join(',')}] factories=[${factoryIds.join(',')}]`,
      );
    }
  }
  // 2. Connection-test delegation (epic P0 §3.4): the APIPanel test button now
  //    exercises each backend's own testConnection() instead of AIService's
  //    former hardcoded branches (which probed Civitai's endpoint for every
  //    image backend).
  aiService.registerConnectionTester('image', (cfg) => measureConnectionTest(async () => {
    const backend = (cfg.backend ?? '') as import('./engine/image/types').ImageBackendType;
    if (!imageProviderRegistry.has(backend)) {
      return { ok: false, error: `未知图片后端 "${cfg.backend ?? ''}"（自定义后端暂不支持连测）` };
    }
    const provider = imageProviderRegistry.resolve({ backend, endpoint: cfg.url, apiKey: cfg.apiKey, model: cfg.model });
    return { ok: await provider.testConnection() };
  }));
  aiService.registerConnectionTester('tts', (cfg) => measureConnectionTest(async () => {
    const backend = (cfg.backend ?? 'cosyvoice') as import('./engine/tts/types').TtsBackendType;
    if (!ttsProviderRegistry.has(backend)) return { ok: false, error: `未知配音后端 "${backend}"` };
    const provider = ttsProviderRegistry.resolve({ backend, endpoint: cfg.url, apiKey: cfg.apiKey, model: cfg.model, routingPath: cfg.customRoutingPath, credentials: cfg.credentials });
    return provider.testConnection({ speaker: cfg.ttsSpeaker });
  }));
  aiService.registerConnectionTester('stt', (cfg) => measureConnectionTest(async () => {
    const backend = (cfg.backend ?? 'cosyvoice') as import('./engine/stt/types').SttBackendType;
    if (!sttProviderRegistry.has(backend)) return { ok: false, error: `未知语音输入后端 "${backend}"` };
    const provider = sttProviderRegistry.resolve({ backend, endpoint: cfg.url, apiKey: cfg.apiKey, model: cfg.model, routingPath: cfg.customRoutingPath, credentials: cfg.credentials });
    return provider.testConnection();
  }));

  // ── #1: 创建 Orchestrator，接通 pipeline:user-input → PipelineRunner ──
  let orchestrator: GameOrchestrator | null = null;
  const vectorNativeRules = parseNativeRules(pack?.rules.plotVector);
  // The general supply pool is pack content; the engine rates and deals it (phase 6).
  const vectorSupplyRules = parseSupplyRules(pack?.rules.plotVector);
  // Rate the pool while the page is idle, so the first board opening or round does not wait for it.
  if (vectorSupplyRules) warmSupplyRatings(vectorSupplyRules, slice => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => slice(), { timeout: 5000 });
    else setTimeout(slice, 50);
  });
  const parsedVectorPolicy = parseVectorPromptPolicy(pack?.rules.plotVectorPrompts, pack?.prompts.plotVectorMode);
  // The mode prompt is read when a round sends it, as the player left it on the prompt page (edited, or '' when
  // switched off); the pack's text only decides whether the pack offers the mode at all.
  const vectorPromptPolicy = parsedVectorPolicy && {
    ...parsedVectorPolicy,
    get mode() { return promptRegistry.getEffectiveContent('plotVectorMode'); },
  };
  const plotVectorBoard = new VectorBoardAccess(stateManager, saveManager, getActiveSlot,
    () => !orchestrator || orchestrator.isBusy, vectorNativeRules,
    () => orchestrator?.onStateEditSettled(),
    // The player's ability retry runs through the round adapter (same repair and binding as Step 3).
    (entryId) => plotVectorAdapter ? plotVectorAdapter.regenerateAbility(entryId) : Promise.reject(new Error('ability-retry-unavailable')),
    vectorSupplyRules);
  if (pack) {
    orchestrator = new GameOrchestrator(
      stateManager,
      commandExecutor,
      behaviorRunner,
      aiService,
      responseParser,
      promptAssembler,
      memoryManager,
      memoryRetriever,
      engramManager,
      saveManager,
      pack,
      DEFAULT_ENGINE_PATHS,
      unifiedRetriever, // E.2/E.3: hybrid 检索路径
      {                 // §G2 + §11.2 B: 子管线包
        memorySummary: memorySummaryPipeline,
        midTermRefine: midTermRefinePipeline,
        characterVectorPropose: characterVectorProposePipeline,
        longTermCompact: longTermCompactPipeline, // 2026-04-11 新增：长期二级精炼
        worldHeartbeat: worldHeartbeatPipeline,
        npcGeneration: npcGenerationPipeline,
        privacyRepair: privacyRepairPipeline,
        fieldRepair: fieldRepairPipeline,
        npcMemorySummarizer: npcMemSummarizer,
        imageService,
        ttsService,
        memoryManager,
        paths: DEFAULT_ENGINE_PATHS,
        plotEvaluation: plotEvaluationPipeline,
        plotVector: plotVectorAdapter = new AgaPlotVectorAdapter(stateManager, aiService, saveManager, getActiveSlot, vectorNativeRules,
          vectorPromptPolicy, vectorSupplyRules),
        stateEditInProgress: () => plotVectorBoard.isSaving,
      },
      {
        // Closures moved verbatim from GameOrchestrator: each resolves its Pinia store at CALL time.
        // PostProcessStage 需要 profileId/slotId，通过闭包从 Pinia store 读取。
        // 这里读取是安全的：闭包只在 autoSave() 中被调用，
        // 彼时 Vue 应用已挂载、Pinia 已激活。
        getActiveSlot: (): { profileId: string; slotId: string } | null => {
          const store = useEngineStateStore();
          if (!store.activeProfileId || !store.activeSlotId) return null;
          return { profileId: store.activeProfileId, slotId: store.activeSlotId };
        },
        // PreProcessStage 消费 action queue；同理通过闭包延迟读取 Pinia store。
        actionQueue: {
          consumeActions: () => useActionQueueStore().consumeActions(),
        },
        promptDebug: {
          recordAssembly: (...args) => usePromptDebugStore().recordAssembly(...args),
          attachResponse: (...args) => usePromptDebugStore().attachResponse(...args),
        },
      },
    );
  }

  // ── CharacterInitPipeline + EnhancedOpeningPipeline (Story 0) ──
  // Created after GameOrchestrator so enhanced opening can access orchestrator.createStagesForOpening()
  let enhancedOpeningPipeline: import('./engine/pipeline/sub-pipelines/enhanced-opening').EnhancedOpeningPipeline | undefined;
  if (pack) {
    if (orchestrator) {
      const { EnhancedOpeningPipeline } = await import('./engine/pipeline/sub-pipelines/enhanced-opening');
      const openingStages = orchestrator.createStagesForOpening();
      enhancedOpeningPipeline = new EnhancedOpeningPipeline(
        stateManager,
        aiService,
        promptAssembler,
        pack,
        orchestrator,
        openingStages,
        DEFAULT_ENGINE_PATHS,
      );
    }
    characterInitPipeline = new CharacterInitPipeline(
      stateManager,
      commandExecutor,
      aiService,
      responseParser,
      promptAssembler,
      saveManager,
      profileManager,
      behaviorRunner,
      pack,
      DEFAULT_ENGINE_PATHS,
      memoryManager,
      enhancedOpeningPipeline,
    );
  }

  // Story 6: game-card import service — Stage-2 deps wired here (all stores now constructed).
  // getPack defaults to the bootstrap singleton; activateSave bridges to the Pinia engineState
  // (engine code must not import the store); runOpening reuses EnhancedOpeningPipeline Phase E–F–G.
  const { DEFAULT_ENHANCED_OPENING_SETTINGS } = await import('./engine/pipeline/sub-pipelines/enhanced-opening');
  const openingPipelineForImport = enhancedOpeningPipeline;
  const gameCardImportService = new GameCardImportService(undefined, {
    stateManager,
    saveManager,
    profileManager,
    imageAssetCache: imageAssetCacheForBackup,
    customPresetStore,
    worldBookStorage,
    configStore,
    promptStorage,
    engramManager,
    hasEmbedder: () => aiService.getConfigForUsage('embedding') !== undefined,
    activateSave: (tree, pkgId, profileId, slotId) =>
      engineStateStore.loadGame(tree, pkgId, profileId, slotId),
    runOpening: openingPipelineForImport
      ? (args) =>
          openingPipelineForImport.executeImportOpening({
            settings: DEFAULT_ENHANCED_OPENING_SETTINGS,
            nsfwMode: args.nsfwMode,
            choices: { selections: {} },
            // No abort: ⑦ is non-cancelable in the UI, so a never-aborting signal is intentional.
            abortSignal: args.abortSignal ?? new AbortController().signal,
            onProgress: args.onProgress ?? (() => {}),
            firstRoundSetup: args.firstRoundSetup, // D7: author opening-style hint
          })
      : undefined,
  });

  const actionQueueStore = useActionQueueStore();
  actionQueueStore.loadFromLocalStorage();

  app.provide('profileManager', profileManager);
  app.provide('saveManager', saveManager);
  app.provide('plotVectorBoard', plotVectorBoard);
  app.provide('promptStorage', promptStorage);
  if (plotDecomposer) app.provide('plotDecomposer', plotDecomposer);
  if (characterVectorProposePipeline) app.provide('characterVectorPropose', characterVectorProposePipeline);
  if (plotReviser) app.provide('plotReviser', plotReviser);
  // Lets the PlotPanel confirmation gate advance a confirmed critical node
  // immediately, instead of waiting for the next main round's evaluation pass.
  if (plotEvaluationPipeline) app.provide('plotEvaluation', plotEvaluationPipeline);
  app.provide('imageService', imageService);
  app.provide('ttsService', ttsService);
  app.provide('sttService', sttService);
  app.provide('vectorStore', vectorStore);
  app.provide('embedder', embedder);
  app.provide('backupService', backupService);
  app.provide('gameCardExportService', gameCardExportService);
  app.provide('gameCardImportService', gameCardImportService);
  // Story 7: card-export preview checks referenced images against the global cache (missing-image warning).
  app.provide('imageAssetCache', imageAssetCacheForBackup);
  app.provide('customPresetStore', customPresetStore);
  app.provide('worldBookStorage', worldBookStorage);

  const githubSync = new GitHubSyncService(backupService);
  app.provide('githubSync', githubSync);

  const lanSync = new LanSyncService(backupService);
  app.provide('lanSync', lanSync);

  // ── 2026-04-14：AI 助手 service ──
  // 复用现有 aiService（按 usageType='assistant' 路由 API 配置）。
  // 启动时 setSettings 从 localStorage 读 maxHistoryTurns 等。
  let assistantSettings = {
    maxHistoryTurns: 5,
    confirmBeforeInject: true,
    confirmBeforeClear: true,
    worldBuilderMode: false,
  };
  try {
    const raw = localStorage.getItem('aga_assistant_settings');
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.maxHistoryTurns === 'number') assistantSettings.maxHistoryTurns = parsed.maxHistoryTurns;
      if (typeof parsed.confirmBeforeInject === 'boolean') assistantSettings.confirmBeforeInject = parsed.confirmBeforeInject;
      if (typeof parsed.confirmBeforeClear === 'boolean') assistantSettings.confirmBeforeClear = parsed.confirmBeforeClear;
      if (typeof parsed.worldBuilderMode === 'boolean') assistantSettings.worldBuilderMode = parsed.worldBuilderMode;
    }
  } catch { /* ignore */ }
  const payloadApplier = new PayloadApplier({
    stateManager,
    commandExecutor,
  });
  const payloadValidator = new PayloadValidator({
    stateManager,
    gamePack: pack,
  });
  const assistantConversationStore = new InMemoryConversationStore();
  const assistantService = new AssistantService({
    aiService,
    stateManager,
    commandExecutor,
    gamePack: pack,
    prompts: promptAssembler,
    settings: assistantSettings,
    locale: i18n.global.locale.value,
    engramManager,
    payloadApplier,
    payloadValidator,
    conversationStore: assistantConversationStore,
  });
  const worldBuilderService = new WorldBuilderService({
    aiService,
    stateManager,
    gamePack: pack,
    prompts: promptAssembler,
    payloadValidator,
    engramManager,
    conversationStore: assistantConversationStore,
    locale: i18n.global.locale.value,
    maxHistoryTurns: assistantSettings.maxHistoryTurns,
  });
  app.provide('assistantService', assistantService);
  app.provide('worldBuilderService', worldBuilderService);
  app.provide('engramEditor', engramEditor);
  app.provide('engramManager', engramManager);
  app.provide('memoryRetriever', memoryRetriever);
  app.provide('configRegistry', configRegistry);
  app.provide('configResolver', configResolver);
  app.provide('eventBus', eventBus);
  app.provide('aiService', aiService);
  app.provide('stateManager', stateManager);
  app.provide('promptAssembler', promptAssembler);
  app.provide('promptRegistry', promptRegistry);
  app.provide('responseParser', responseParser);

  if (pack) {
    app.provide('gamePack', pack);
  }
  if (characterInitPipeline) {
    app.provide('characterInitPipeline', characterInitPipeline);
  }
  if (orchestrator) {
    app.provide('gameOrchestrator', orchestrator);
  }
  if (npcChatPipeline) {
    // §7.2: 注入 NPC 私聊管线，供 RelationshipPanel / NpcChatModal 使用
    app.provide('npcChatPipeline', npcChatPipeline);

    // ── CR-R7: 读档/创角完成后对所有 NPC 的 `私聊历史` 做一次性回溯性 trim ──
    // 场景：旧存档里 `私聊历史` 数组可能超过当前 maxChatHistory（例如 pack 调低了上限，
    // 或从未 trim 过的历史积累）。StateManager.loadTree 完成时 emit 'engine:state-changed'
    // type='load'，此时一次性收敛。运行时的增量 trim 已在 NpcChatPipeline.execute 内处理。
    const pipelineForTrim = npcChatPipeline;
    eventBus.on<{ type?: string }>('engine:state-changed', (payload) => {
      if (payload?.type === 'load') {
        pipelineForTrim.trimAllChatHistories();
      }
    });
  }

  app.mount('#app');
  eventBus.emit('engine:initialized', { packId: pack?.manifest.id ?? null });

  // 申请持久化存储：避免本源 IndexedDB 在磁盘紧张 / LRU 驱逐下被浏览器自动清空。
  // 放在 mount 之后，保证授予被拒时的警告 toast 能被已挂载的 Toast 组件显示。
  // 不 await —— 申请结果不阻断后续启动逻辑。
  void requestPersistentStorage();

  // Load world books when a game profile becomes active (fixes: first round with empty books)
  const engineState = useEngineStateStore();
  let lastWorldBookPid: string | null = null;
  // Watch only the profile id: `$subscribe` deep-watches the whole store state, which holds the game tree,
  // so every state change walked the entire tree (0.6 s per write on a large save).
  watch(() => engineState.activeProfileId, async (pid) => {
    if (!pid || pid === lastWorldBookPid) return;
    lastWorldBookPid = pid;
    try {
      const loadedBooks = await worldBookStorage.loadWorldBooks(pid);
      eventBus.emit('worldbook:updated', loadedBooks.filter((b) => b.enabled !== false));
    } catch { /* best-effort */ }
  }, { immediate: true });
}

bootstrap().catch(console.error);
