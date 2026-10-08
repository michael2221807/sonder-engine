import type { AIService } from '../engine/ai/ai-service';
import type { StateManager } from '../engine/core/state-manager';
import { Embedder } from '../engine/memory/engram/embedder';
import { EngramEditor } from '../engine/memory/engram/engram-editor';
import { EngramManager } from '../engine/memory/engram/engram-manager';
import { Reranker } from '../engine/memory/engram/reranker';
import { UnifiedRetriever } from '../engine/memory/engram/unified-retriever';
import type { VectorStore } from '../engine/memory/engram/vector-store';
import { DEFAULT_ENGINE_PATHS } from '../engine/pipeline/types';
import type { useEngineStateStore } from '../engine/stores/engine-state';
import { useEngramDebugStore } from '../engine/stores/engram-debug';

/** Moved verbatim out of main.ts bootstrap() (R5 step 5). Statement order inside is behavior. */
export function createEngramStack(deps: {
  aiService: AIService;
  stateManager: StateManager;
  engineStateStore: ReturnType<typeof useEngineStateStore>;
  vectorStore: VectorStore;
}) {
  const { aiService, stateManager, engineStateStore, vectorStore } = deps;
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

  return { getActiveSlot, engramManager, engramEditor, embedder, unifiedRetriever };
}
