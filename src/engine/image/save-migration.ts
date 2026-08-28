// App doc: docs/user-guide/pages/game-image.md §参考图与图片提炼设置（默认值来源）
/**
 * Image subsystem save migration — Sprint Image-6
 *
 * When loading a save that predates the image subsystem, this helper
 * initializes the missing `系统.扩展.image` subtree with sensible defaults.
 * Called during save load (by persistence layer).
 *
 * Idempotent: if the subtree already exists, does nothing.
 */
import type { StateManager } from '../core/state-manager';
import type { CivitaiLoraShelfItem } from './types';

const IMAGE_ROOT_PATH = '系统.扩展.image';

const DEFAULT_IMAGE_STATE = {
  enabled: false,
  config: {
    autoSceneOnRound: false,
    autoPortraitForMajorNpcs: false,
    defaultBackend: 'novelai',
    defaultPresetId: null,
    defaultStyle: 'generic',
    defaultComposition: 'half-body',
    useTransformer: true,
    defaultNpcArtistPreset: '',
    defaultNpcPngPreset: '',
    defaultSceneArtistPreset: '',
    defaultScenePngPreset: '',
    secretForceNude: true,
    sceneHistoryLimit: 10,
    novelai: {
      customParamsEnabled: false,
      sampler: 'k_euler',
      noiseSchedule: 'native',
      steps: 28,
      cfgScale: 5,
      smea: false,
      seed: 0,
      negativeDefault: '',
    },
    civitai: {
      allowMatureContent: false,
      scheduler: 'EulerA',
      steps: 25,
      cfgScale: 7,
      seed: -1,
      clipSkip: 2,
      outputFormat: 'png',
      additionalNetworksJson: '',
      controlNetsJson: '',
      loras: [] as CivitaiLoraShelfItem[],
    },
    reference: {
      enabled: true,
      persistUploadedReferences: true,
      maxUploadBytes: 10 * 1024 * 1024,
      defaultDenoiseStrength: 0.65,
      preserveSourceDimensions: false,
      // 旧 reference.civitai.{understandingEnabled,wdTaggingModel,wdThreshold,
      // captionTemperature,captionMaxNewTokens} 已随 wdTagging/JoyCaption 拆除
      // （图片提炼重建 epic D5）；imageToImageEnabled 仍由参考重绘链路消费。
      civitai: {
        imageToImageEnabled: true,
      },
      novelai: {
        imageToImageEnabled: true,
        validationStatus: 'validated' as const,
        defaultStrength: 0.55,
        defaultNoise: 0.1,
      },
    },
    // 图片提炼（重建 epic §4）：双引擎设置
    understanding: {
      defaultEngine: 'civitai_vlm',
      civitaiModel: 'claude-sonnet-5',
      temperature: 0.2,
      // 600（原 300）：人体优先提示词要求「有序 tags + 2-4 句 caption」，
      // 300 token 会把 JSON 截断成解析失败（2026-08-28 人体细节强化）。
      maxNewTokens: 600,
      /** 新存档已是新默认，无需一次性提额（见下方 bump 迁移） */
      maxNewTokensBumped: true,
    },
    transformer: {
      independentEnabled: false,
      endpoint: '',
      apiKey: '',
      model: '',
    },
    scene: {
      independentEnabled: false,
      backend: 'novelai',
      endpoint: '',
      apiKey: '',
      model: '',
      defaultStyle: 'generic',
      composition: 'landscape',
      orientation: 'landscape',
      resolution: '',
      customResolution: '',
    },
    auto: {
      genderFilter: 'all',
      importanceFilter: 'major',
      historyLimit: 50,
      sceneComposition: 'landscape',
      sceneOrientation: 'landscape',
      sceneResolution: '1024x576',
      npcStyle: 'generic',
    },
  },
  tasks: [],
  assets: {},
  stylePresets: [],
  artistPresets: [],
  characterAnchors: [],
  transformerPresets: [],
  modelRulesets: [],
  ruleTemplates: [],
  rules: {
    activeNpcRule: '',
    activeSceneRule: '',
    activeJudgeRule: '',
    npcEnabled: false,
    sceneEnabled: false,
    judgeEnabled: false,
  },
  referenceLibrary: [],
  playerImages: [],
  playerAnchor: null,
  sceneArchive: {
    生图历史: [],
    当前壁纸图片ID: '',
  },
};

export function migrateImageState(stateManager: StateManager): boolean {
  const existing = stateManager.get<unknown>(IMAGE_ROOT_PATH);

  if (existing === undefined || existing === null) {
    stateManager.set(IMAGE_ROOT_PATH, DEFAULT_IMAGE_STATE, 'system');
    console.debug('[ImageMigration] Initialized image subtree for pre-image save');
    return true;
  }

  let migrated = false;
  const civitaiPath = `${IMAGE_ROOT_PATH}.config.civitai`;
  if (stateManager.get<unknown>(civitaiPath) === undefined) {
    stateManager.set(civitaiPath, DEFAULT_IMAGE_STATE.config.civitai, 'system');
    console.debug('[ImageMigration] Added civitai config defaults to existing save');
    migrated = true;
  }

  // Field-level: add loras array if civitai config exists but loras is missing/null
  const lorasPath = `${civitaiPath}.loras`;
  if (stateManager.get<unknown>(civitaiPath) !== undefined
      && stateManager.get<unknown>(lorasPath) == null) {
    stateManager.set(lorasPath, [], 'system');
    console.debug('[ImageMigration] Added loras[] to existing civitai config');
    migrated = true;
  }

  // Field-level: add reference config if missing
  const referencePath = `${IMAGE_ROOT_PATH}.config.reference`;
  if (stateManager.get<unknown>(referencePath) == null) {
    stateManager.set(referencePath, DEFAULT_IMAGE_STATE.config.reference, 'system');
    console.debug('[ImageMigration] Added reference config defaults to existing save');
    migrated = true;
  }

  // Field-level: add referenceLibrary if missing
  const refLibPath = `${IMAGE_ROOT_PATH}.referenceLibrary`;
  if (stateManager.get<unknown>(refLibPath) == null) {
    stateManager.set(refLibPath, [], 'system');
    console.debug('[ImageMigration] Added referenceLibrary[] to existing save');
    migrated = true;
  }

  // Field-level: add understanding config if missing（图片提炼重建 epic §4）。
  // 幂等一次性迁移：旧 WD/JoyCaption 时代用户改过的 temperature（≠0.2）与
  // maxNewTokens（≠160 旧默认）迁入新键；等于旧默认的值不迁（新默认 300 面向 VLM JSON 输出）。
  const understandingPath = `${IMAGE_ROOT_PATH}.config.understanding`;
  if (stateManager.get<unknown>(understandingPath) == null) {
    const legacyTemp = stateManager.get<number>(`${referencePath}.civitai.captionTemperature`);
    const legacyMaxTokens = stateManager.get<number>(`${referencePath}.civitai.captionMaxNewTokens`);
    stateManager.set(understandingPath, {
      ...DEFAULT_IMAGE_STATE.config.understanding,
      ...(typeof legacyTemp === 'number' && legacyTemp !== 0.2 ? { temperature: legacyTemp } : {}),
      ...(typeof legacyMaxTokens === 'number' && legacyMaxTokens !== 160 ? { maxNewTokens: legacyMaxTokens } : {}),
    }, 'system');
    console.debug('[ImageMigration] Added understanding config defaults to existing save');
    migrated = true;
  }

  // Field-level 一次性提额（2026-08-28 人体细节强化）：提炼提示词改为「有序 tags
  // + 2-4 句 caption」后，旧默认 300 token 会把 JSON 截断成解析失败。只提旧默认
  // 值（300），用户自定义过的值不动；`maxNewTokensBumped` 标记保证只跑一次，
  // 用户之后主动改回 300 不会被再次改写。
  // 已知边界（可接受）：WD 时代把 captionMaxNewTokens 恰好设成 300 的用户，其值
  // 会被上面的 legacy 迁移带进来并同时打上 bumped 标记 → 停在 300。那 300 本来
  // 就是他自己设的（旧默认是 160），尊重用户设置比强行提额更合理。
  const bumpFlagPath = `${understandingPath}.maxNewTokensBumped`;
  if (stateManager.get<unknown>(understandingPath) != null
      && stateManager.get<boolean>(bumpFlagPath) !== true) {
    if (stateManager.get<number>(`${understandingPath}.maxNewTokens`) === 300) {
      stateManager.set(`${understandingPath}.maxNewTokens`, 600, 'system');
      console.debug('[ImageMigration] Bumped understanding.maxNewTokens 300 → 600');
      // 只有真正改了用户可见的值才算 migrated——标记本身是簿记，不该把
      // 「什么都没变」的存档标脏（否则四个既有 no-op 用例全部翻车）。
      migrated = true;
    }
    stateManager.set(bumpFlagPath, true, 'system');
  }

  return migrated;
}
