// App doc: docs/user-guide/pages/game-prompt-assembly.md §5.3（上下文编译 · 分步第 2 步投影接线）· game-main.md §3.5（指标药丸）
/**
 * 上下文组装阶段 — 将游戏状态、记忆、行为模块输出组装为 AI 消息列表
 *
 * execute() 分两段：先读本回合的输入（context-assembly-inputs.ts：存档、设置、记忆检索），
 * 再按路径构造请求（context-assembly-requests.ts：context-piece builder 路径或 flow 路径）。
 *
 * 记忆检索：engram.enabled && retrievalMode='hybrid' 时用 UnifiedRetriever；
 * 否则用 memoryRetriever（四层记忆的全量转储，没有关键词或时间衰减打分）。
 *
 * 对应 STEP-03B M3.4 ContextAssemblyStage。
 */
import type {
  PipelineStage,
  PipelineContext,
  IMemoryRetriever,
  IBehaviorRunner,
  IEngramManager,
  IUnifiedRetriever,
  EnginePathConfig,
} from '../types';
import type { GamePack } from '../../types';
import type { StateManager } from '../../core/state-manager';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import type { WorldBook } from '../../prompt/world-book';
import { collectRoundInputs, buildFlowVariables } from './context-assembly-inputs';
import {
  assembleStoryRequest,
  assembleFlowRequests,
  finalizeRequests,
  type RequestDeps,
} from './context-assembly-requests';

export class ContextAssemblyStage implements PipelineStage {
  name = 'ContextAssembly';

  constructor(
    private stateManager: StateManager,
    private promptAssembler: PromptAssembler,
    private memoryRetriever: IMemoryRetriever,
    private behaviorRunner: IBehaviorRunner,
    private pack: GamePack,
    private paths: EnginePathConfig,
    /** E.2: Engram 管理器，用于读取当前检索配置 */
    private engramManager?: IEngramManager,
    /** E.2: 统一检索器，hybrid 模式时使用 */
    private unifiedRetriever?: IUnifiedRetriever,
    /** World book getter: returns current world books (supports live updates) */
    private getWorldBooks?: () => WorldBook[],
    /** Whether to use the new context-piece builder (default: false for backward compat) */
    private useNewBuilder?: boolean,
    /**
     * gproxy prompt cache flag getter — reads the resolved main LLM config's
     * `gproxyPromptCache` at build time (live, so toggling it takes effect next
     * round). When true, buildSystemPrompt hoists the static prefix + embeds the
     * cache trigger. Absent/false = legacy output.
     */
    private getGproxyCacheEnabled?: () => boolean,
    private getPromptTransform?: (ctx: PipelineContext) => import('../../prompt/raw-prompt-transform').RawPromptTransform | undefined,
  ) {}

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    const transformPrompt = this.getPromptTransform?.(ctx);
    const assembler = this.promptAssembler.withTransform(transformPrompt);
    const inputs = await collectRoundInputs({
      stateManager: this.stateManager,
      memoryRetriever: this.memoryRetriever,
      pack: this.pack,
      paths: this.paths,
      engramManager: this.engramManager,
      unifiedRetriever: this.unifiedRetriever,
      getWorldBooks: this.getWorldBooks,
    }, ctx);
    const variables = buildFlowVariables({
      stateManager: this.stateManager,
      pack: this.pack,
      paths: this.paths,
      behaviorRunner: this.behaviorRunner,
    }, ctx, inputs);
    const deps: RequestDeps = {
      stateManager: this.stateManager,
      promptAssembler: this.promptAssembler,
      pack: this.pack,
      paths: this.paths,
      getGproxyCacheEnabled: this.getGproxyCacheEnabled,
    };
    // Builder path (context pieces) or flow-based path; both edit their message arrays in place.
    const draft = this.useNewBuilder
      ? assembleStoryRequest(deps, ctx, inputs, variables, assembler, transformPrompt)
      : assembleFlowRequests(deps, ctx, inputs, variables, assembler);
    return finalizeRequests(ctx, inputs, variables, assembler, draft);
  }
}

export { buildBookmarkedRoundsBlock } from './context-assembly-inputs';
