/**
 * The engine's own state-tree paths under `系统.*` — the settings, the NSFW switches, the action-option style and the
 * image subsystem's data root.
 *
 * Why this is not in `EnginePathConfig`: `系统` is the engine's extension data area (schema-contract §1.1), not
 * pack content — a pack does not rename it. Keeping it out of the injectable config also keeps the test doubles
 * (`as unknown as EnginePathConfig`) from having to supply more keys.
 *
 * Every leaf is written out in full so a grep for the path finds this line. Sub-keys of the image subtree are NOT
 * listed — build them with the root: `${SYSTEM_PATHS.image.config}.autoSceneOnRound`.
 *
 * Runtime leaf: this module must not import anything. `pipeline/types.ts` and the sanitizer build tables from it
 * when they load.
 */
export const SYSTEM_PATHS = {
  /** All settings the player sets in the tree (stripped from the prompt state, kept across a rollback). */
  settings: '系统.设置',
  /** The prompt page's game settings (`PromptSettings`). */
  promptSettings: '系统.设置.prompt',
  /** Body-polish switch. */
  bodyPolish: '系统.设置.bodyPolish',
  /** Presence-partition switch of the social settings. */
  presenceEnabled: '系统.设置.social.presenceEnabled',
  cotEnabled: '系统.设置.cot.enabled',
  cotJudgeEnabled: '系统.设置.cot.judgeEnabled',
  cotInjectStep2: '系统.设置.cot.injectStep2',
  cotReasoningRingSize: '系统.设置.cot.reasoningRingSize',
  /** The plot settings object. */
  plotSettings: '系统.设置.plot',
  plotEnabled: '系统.设置.plot.enabled',
  plotMaxActiveThreads: '系统.设置.plot.maxActiveThreads',
  /** NSFW switch and gender filter copied from the device. */
  nsfwMode: '系统.nsfwMode',
  nsfwGenderFilter: '系统.nsfwGenderFilter',
  /** Action-option style copied from the device. */
  actionOptions: '系统.actionOptions',
  actionOptionsMode: '系统.actionOptions.mode',
  actionOptionsPace: '系统.actionOptions.pace',
  actionOptionsCustomPrompt: '系统.actionOptions.customPrompt',
  /** Location names the NPC generation sub-pipeline already ran for. */
  generatedNpcLocations: '系统.已生成NPC地点',
  /** Image subsystem: the root and the first-level subtrees only. */
  image: {
    root: '系统.扩展.image',
    enabled: '系统.扩展.image.enabled',
    config: '系统.扩展.image.config',
    tasks: '系统.扩展.image.tasks',
    sceneArchive: '系统.扩展.image.sceneArchive',
    referenceLibrary: '系统.扩展.image.referenceLibrary',
  },
} as const;
