/**
 * NPC Memory Summarizer — Sprint Social-5
 *
 * When an NPC's `记忆` array reaches the threshold (from `rules/npc-memory.json`),
 * summarizes the oldest entries into a `总结记忆` entry and trims the array.
 *
 * Per PRINCIPLES §3.9: additive plugin. Gated by `rules.npcMemory.autoSummarize`.
 * Per PRINCIPLES §3.11: uses existing `UsageType.memory_summary` for the LLM call.
 */
import type { AIService } from '../ai/ai-service';
import type { PromptAssembler } from '../prompt/prompt-assembler';
import type { StateManager } from '../core/state-manager';
import type { EnginePathConfig } from '../pipeline/types';
import { formatMemoryEntry } from './npc-memory-format';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';

interface NpcMemoryConfig {
  threshold: number;
  reserveCount: number;
  summaryMaxLength: number;
}

const DEFAULT_CONFIG: NpcMemoryConfig = {
  threshold: 20,
  reserveCount: 5,
  summaryMaxLength: 400,
};

export class NpcMemorySummarizer {
  constructor(
    private stateManager: StateManager,
    private aiService: AIService,
    private promptAssembler: PromptAssembler,
    private paths: EnginePathConfig,
    private config: NpcMemoryConfig = DEFAULT_CONFIG,
  ) {}

  /**
   * Scan all NPCs for memory arrays exceeding the threshold.
   * Returns names of NPCs that need summarization.
   */
  findCandidates(): string[] {
    const list = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.relationships) ?? [];
    const memoryKey = this.paths.npcFieldNames?.memory ?? '记忆';
    const nameKey = this.paths.npcFieldNames?.name ?? '名称';
    const candidates: string[] = [];

    for (const npc of list) {
      const memory = npc[memoryKey];
      if (Array.isArray(memory) && memory.length >= this.config.threshold) {
        const name = typeof npc[nameKey] === 'string' ? npc[nameKey] as string : '';
        if (name) candidates.push(name);
      }
    }

    return candidates;
  }

  /**
   * Summarize an NPC's oldest memory entries and write the result back.
   */
  async summarize(npcName: string): Promise<void> {
    const list = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.relationships);
    if (!Array.isArray(list)) return;

    const nameKey = this.paths.npcFieldNames?.name ?? '名称';
    const memoryKey = this.paths.npcFieldNames?.memory ?? '记忆';
    const summariesKey = this.paths.npcFieldNames?.memorySummaries ?? '总结记忆';

    const npcIdx = list.findIndex((n) => n[nameKey] === npcName);
    if (npcIdx < 0) return;

    const npc = list[npcIdx];
    const memories = npc[memoryKey] as unknown[] | undefined;
    if (!Array.isArray(memories) || memories.length < this.config.threshold) return;

    const toSummarize = memories.slice(0, memories.length - this.config.reserveCount);
    const toKeep = memories.slice(memories.length - this.config.reserveCount);

    const rendered = toSummarize.map(formatMemoryEntry).filter(Boolean);
    const summaryText = await this.generateSummary(npcName, rendered);

    const summaryEntry: Record<string, string> = {};
    summaryEntry['摘要'] = summaryText.slice(0, this.config.summaryMaxLength);
    summaryEntry['summary'] = summaryEntry['摘要'];
    summaryEntry['涵盖范围'] = `${rendered.length} entries`;
    summaryEntry['生成时间'] = this.getCurrentGameTime();

    const updatedNpc = { ...npc };
    updatedNpc[memoryKey] = toKeep;
    const existingSummaries = Array.isArray(npc[summariesKey]) ? [...(npc[summariesKey] as unknown[])] : [];
    existingSummaries.push(summaryEntry);
    updatedNpc[summariesKey] = existingSummaries;

    const updatedList = [...list];
    updatedList[npcIdx] = updatedNpc;
    this.stateManager.set(this.paths.relationships, updatedList, 'system');
  }

  private async generateSummary(npcName: string, entries: string[]): Promise<string> {
    const promptContent = this.promptAssembler.renderSingle('npcMemorySummary', {
      NPC_NAME: npcName,
      MEMORY_ENTRIES: entries.map((e, i) => `${i + 1}. ${e}`).join('\n'),
      MAX_LENGTH: String(this.config.summaryMaxLength),
    });

    if (!promptContent) {
      return entries.slice(0, 3).join(' → ') + '…';
    }

    const result = await this.aiService.generate({
      messages: [
        { role: 'system', content: promptContent },
        { role: 'user', content: `请总结以上 ${entries.length} 条记忆为一段不超过 ${this.config.summaryMaxLength} 字的摘要。` },
      ],
      stream: false,
      usageType: 'memory_summary',
    });

    return result.trim();
  }

  private getCurrentGameTime(): string {
    const t = this.stateManager.get<Record<string, unknown>>(this.paths.gameTime);
    if (!t || typeof t !== 'object') return '未知';
    return `${t[DEFAULT_ENGINE_PATHS.gameTimeFieldNames.year] ?? 0}年${t[DEFAULT_ENGINE_PATHS.gameTimeFieldNames.month] ?? 0}月${t[DEFAULT_ENGINE_PATHS.gameTimeFieldNames.day] ?? 0}日`;
  }
}
