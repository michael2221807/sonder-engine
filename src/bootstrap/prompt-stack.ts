import { ResponseParser } from '../engine/ai/response-parser';
import { eventBus } from '../engine/core/event-bus';
import { isPromptAlwaysOn } from '../engine/prompt/builtin-slots';
import { PromptAssembler } from '../engine/prompt/prompt-assembler';
import { hydratePromptRegistry, migrateLegacyBuiltinOverrides, resplitPromptEdits } from '../engine/prompt/prompt-edits';
import { PromptRegistry } from '../engine/prompt/prompt-registry';
import { TemplateEngine } from '../engine/prompt/template-engine';
import type { WorldBookStorage } from '../engine/prompt/world-book-storage';
import type { GamePack } from '../engine/types';

/** Moved verbatim out of main.ts bootstrap() (R5 step 5). Statement order inside is behavior. */
export function createPromptStack(deps: {
  pack: GamePack | null;
  worldBookStorage: WorldBookStorage;
}) {
  const { pack, worldBookStorage } = deps;
  const promptRegistry = new PromptRegistry();
  if (pack) promptRegistry.registerPack(pack.prompts, isPromptAlwaysOn);

  // The prompt page's edits (prompt-edits.ts): loaded now, and again whenever something replaces them.
  if (pack) {
    const packId = pack.manifest.id, promptIds = Object.keys(pack.prompts);
    // An edit made before the pack split a prompt in two is re-split first (code review M1, 2026-10-05).
    const loadEdits = (): void => {
      resplitPromptEdits(packId, pack.manifest.promptSplits ?? [], pack.prompts);
      hydratePromptRegistry(promptRegistry, packId, promptIds);
    };
    loadEdits();
    eventBus.on<{ packId?: string }>('prompt:edits-replaced', (payload) => {
      if (!payload?.packId || payload.packId === packId) loadEdits();
    });
    // The retired world-book slot-override store: what a restored backup or an old card import left there joins the
    // page's edits once (P7 A). Async; the registry reloads when anything moved.
    void migrateLegacyBuiltinOverrides(worldBookStorage, packId)
      .then((moved) => { if (moved > 0) eventBus.emit('prompt:edits-replaced', { packId }); })
      .catch((err: unknown) => console.warn('[PromptEdits] Moving old built-in prompt overrides failed:', err));
  }

  const templateEngine = new TemplateEngine();
  const responseParser = new ResponseParser();
  const promptAssembler = new PromptAssembler(promptRegistry, templateEngine);

  return { promptRegistry, responseParser, promptAssembler };
}
