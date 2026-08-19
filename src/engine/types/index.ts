/**
 * Unified type exports for the engine
 *
 * All engine modules should import types from '@/engine/types'
 * rather than from individual type files.
 */

// ─── State & Command ───
export type {
  GameStateTree,
  StatePath,
  CommandAction,
  StateChange,
  ChangeLog,
  Command,
  CommandResult,
  BatchCommandResult,
  QueuedAction,
} from './state';

// ─── Config System ───
export type {
  ConfigDomainId,
  ConfigDomain,
  ConfigOverlay,
  ResolvedConfig,
} from './config';

// ─── Persistence ───
export type {
  SaveSlotMeta,
  ProfileMeta,
  StorageRoot,
  Migration,
} from './persistence';

// ─── Game Pack ───
export type {
  GamePackManifest,
  GamePack,
  CreationFlowConfig,
  CreationStep,
  FormFieldConfig,
  DetailField,
  PromptFlowConfig,
  PromptFlowModule,
  CustomPresetSchema,
  CustomPresetField,
  PresetEntry,
  WorldPresetEntry,
  CreationChoicePresetEntry,
  CreationGenre,
  CreationContentRating,
  CreationGenreScope,
} from './game-pack';

// ─── Behavior Module Configs ───
export type {
  CalendarConfig,
  EffectLifecycleConfig,
  IntegrityRule,
  ComputedFieldConfig,
  ThresholdTriggerConfig,
  ContentFilterConfig,
  NpcBehaviorConfig,
} from './behaviors';

// ─── Event Bus ───
export type {
  EngineEventName,
  ToastPayload,
  EventHandler,
} from './event-bus';
