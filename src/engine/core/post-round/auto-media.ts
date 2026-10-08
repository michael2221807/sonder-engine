import { eventBus } from '../event-bus';
import { SYSTEM_PATHS } from '../../pipeline/system-paths';
import { DEFAULT_ENGINE_PATHS } from '../../pipeline/types';
import type { PipelineContext } from '../../pipeline/types';
import type { GameTime } from '../../image/scene-context';
import type { ImageBackendType, StylePreset } from '../../image/types';
import { parseSizeString } from '../../image/image-size-options';
import { ART_STYLE_PROMPT_LABELS } from '../../image/tokenizer';
import { TIANMING_GENDER_VALUES, TIANMING_IMAGE_ARCHIVE_KEYS, TIANMING_LEGACY_NPC_KEYS } from '../../pack/tianming-coupling';
import type { PostRoundEnv } from './types';

/*
 * Auto media sections. These three functions are deliberately SYNCHRONOUS (no await):
 * the fire-and-forget `.then(toast)` ordering between them depends on that.
 */
export function runAutoScene(env: PostRoundEnv, ctx: PipelineContext): void {
  const { sub, stateManager } = env;
  // ── Auto scene generation (post-round) ──
  // D27: Skip ImageService during enhanced opening
  if (sub.imageService && !ctx.meta?.isEnhancedOpening) {
    const autoScene = stateManager.get<boolean>(`${SYSTEM_PATHS.image.config}.autoSceneOnRound`) === true;
    const imageEnabled = stateManager.get<boolean>(SYSTEM_PATHS.image.enabled) === true;
    if (autoScene && imageEnabled && ctx.parsedResponse?.text) {
      try {
        const paths = sub.paths;
        const location = stateManager.get<string>(paths?.playerLocation ?? DEFAULT_ENGINE_PATHS.playerLocation) ?? '';
        const defaultBackend = (stateManager.get<string>(`${SYSTEM_PATHS.image.config}.defaultBackend`) ?? 'novelai') as ImageBackendType;
        eventBus.emit('ui:toast', { type: 'info', i18nKey: 'engine.toast.autoSceneGenStart', message: '正在自动生成场景图…', duration: 2000 });
        // P3 env-tags port (2026-04-19): forward env state so auto-gen scene
        // images reflect current weather/festival/environment (same plumbing
        // as ImagePanel.vue manual generation).
        const sceneAnchors = sub.imageService.collectSceneRoleAnchors();
        // Consume the auto-scene settings the Settings tab writes (they were
        // previously dead controls): resolution → preset width/height,
        // composition → pure_landscape / story_snapshot.
        const autoResolution = parseSizeString(stateManager.get<string>(`${SYSTEM_PATHS.image.config}.auto.sceneResolution`) ?? '');
        const autoOrientation = stateManager.get<string>(`${SYSTEM_PATHS.image.config}.auto.sceneOrientation`) === 'portrait' ? 'portrait' : 'landscape';
        const fallbackSize = autoOrientation === 'portrait' ? { width: 576, height: 1024 } : { width: 1024, height: 576 };
        const autoSize = autoResolution ?? fallbackSize;
        const autoScenePreset: StylePreset = {
          id: 'auto_scene', name: 'auto scene', positivePrefix: '', positiveSuffix: '', negative: '',
          source: 'auto', width: autoSize.width, height: autoSize.height,
        };
        const autoComposition = stateManager.get<string>(`${SYSTEM_PATHS.image.config}.auto.sceneComposition`) === 'snapshot'
          ? 'story_snapshot' as const : 'pure_landscape' as const;
        sub.imageService.generateSceneImage({
          sceneDescription: ctx.parsedResponse.text.slice(0, 800),
          location,
          gameTime: paths ? stateManager.get<GameTime | null>(paths.gameTime) ?? undefined : undefined,
          weather: paths ? stateManager.get<string>(paths.weather) : undefined,
          festival: paths ? stateManager.get<unknown>(paths.festival) : undefined,
          environment: paths ? stateManager.get<unknown>(paths.environmentTags) : undefined,
          backend: defaultBackend,
          compositionMode: autoComposition,
          preset: autoScenePreset,
          presentNpcs: sceneAnchors.presentNpcs,
          roleAnchors: sceneAnchors.roleAnchors.length > 0 ? sceneAnchors.roleAnchors : undefined,
        }).then(() => {
          eventBus.emit('ui:toast', { type: 'success', i18nKey: 'engine.toast.autoSceneGenComplete', message: '场景图已生成', duration: 2000 });
        }).catch((err) => console.debug('[Orchestrator] Auto scene gen failed:', err));
      } catch (err) {
        console.debug('[Orchestrator] Auto scene trigger error:', err);
      }
    }
  }
}

export function runAutoPortrait(env: PostRoundEnv, ctx: PipelineContext): void {
  const { sub, stateManager } = env;
  // ── Auto NPC portrait (first appearance) ──
  // D27: Skip ImageService during enhanced opening (same guard as auto scene above)
  if (sub.imageService && !ctx.meta?.isEnhancedOpening) {
    const autoPortrait = stateManager.get<boolean>(`${SYSTEM_PATHS.image.config}.autoPortraitForMajorNpcs`) === true;
    const imageEnabled = stateManager.get<boolean>(SYSTEM_PATHS.image.enabled) === true;
    if (autoPortrait && imageEnabled) {
      try {
        const portraitPaths = sub.paths ?? DEFAULT_ENGINE_PATHS;
        const npcFields = portraitPaths.npcFieldNames;
        const relations = stateManager.get<Array<Record<string, unknown>>>(portraitPaths.relationships) ?? [];
        const genderFilter = stateManager.get<string>(`${SYSTEM_PATHS.image.config}.auto.genderFilter`) ?? 'all';
        const importanceFilter = stateManager.get<string>(`${SYSTEM_PATHS.image.config}.auto.importanceFilter`) ?? 'major';
        const defaultBackend = (stateManager.get<string>(`${SYSTEM_PATHS.image.config}.defaultBackend`) ?? 'novelai') as ImageBackendType;
        // Consume the "NPC 默认画风" setting (was a dead control): stored as a
        // style KEY ('generic'|'anime'|'realistic'|'chinese') → prompt label.
        const npcStyleKey = stateManager.get<string>(`${SYSTEM_PATHS.image.config}.auto.npcStyle`) ?? 'generic';
        const npcArtStyle = ART_STYLE_PROMPT_LABELS[npcStyleKey] ?? ART_STYLE_PROMPT_LABELS.generic;

        for (const npc of relations) {
          const name = String(npc[npcFields.name] ?? '');
          if (!name) continue;
          const isMajor = npc[npcFields.isMajorRole] === true;
          if (importanceFilter === 'major' && !isMajor) continue;
          const gender = String(npc[npcFields.gender] ?? '');
          if (genderFilter === 'male' && gender !== TIANMING_GENDER_VALUES.male) continue;
          if (genderFilter === 'female' && gender !== TIANMING_GENDER_VALUES.female) continue;

          const archive = npc[DEFAULT_ENGINE_PATHS.npcFieldNames.imageArchive] as Record<string, unknown> | undefined;
          const hasAvatar = !!archive?.[TIANMING_IMAGE_ARCHIVE_KEYS.selectedAvatarId];
          if (hasAvatar) continue;

          // No avatar yet — auto-generate
          sub.imageService.generateCharacterImage({
            characterName: name,
            description: String(npc[DEFAULT_ENGINE_PATHS.npcFieldNames.description] ?? ''),
            appearance: String(npc[TIANMING_LEGACY_NPC_KEYS.appearanceAlias] ?? npc[DEFAULT_ENGINE_PATHS.npcFieldNames.description] ?? ''),
            backend: defaultBackend,
            artStyle: npcArtStyle,
          }).then(() => {
            eventBus.emit('ui:toast', { type: 'success', i18nKey: 'engine.toast.autoPortraitComplete', i18nParams: { name }, message: `${name} 自动肖像已生成`, duration: 2000 });
          }).catch((err) => console.debug(`[Orchestrator] Auto portrait for ${name} failed:`, err));
        }
      } catch (err) {
        console.debug('[Orchestrator] Auto portrait trigger error:', err);
      }
    }
  }
}

export function runAutoNarration(env: PostRoundEnv, ctx: PipelineContext): void {
  const { sub, stateManager } = env;
  // ── Auto narration (post-round TTS) ──
  // Global preference (aga_tts_settings, held on TtsService). Fire-and-forget:
  // TtsService.speak() is self-contained (splits/strips markers, plays via
  // audio queue, swallows errors → toast). Skip during enhanced opening.
  if (sub.ttsService && !ctx.meta?.isEnhancedOpening) {
    try {
      // 下回合生成完毕 → 删除上一回合的全配音缓存(内存卫生 + 用户要求)。
      // 若随后自动配音,speak() 会重新捕获本回合;否则缓存归零、下载入口隐藏。
      sub.ttsService.clearRoundAudio();
      const ttsSettings = sub.ttsService.getSettings();
      if (ttsSettings.enabled && ttsSettings.autoNarrateOnRound && ctx.parsedResponse?.text) {
        const roundNo = stateManager.get<number>(sub.paths?.roundNumber ?? DEFAULT_ENGINE_PATHS.roundNumber) ?? 0;
        // fire-and-forget — do NOT await (post-round pipeline must not block on TTS)
        void sub.ttsService.speak(ctx.parsedResponse.text, `round-${roundNo}`);
      }
    } catch (err) {
      console.debug('[Orchestrator] Auto narration trigger error:', err);
    }
  }
}
