/**
 * Engine event names — typed union for known events, plus open-ended custom events.
 * UI components (Toast, Modal, LoadingOverlay) listen to 'ui:*' events.
 */
export type EngineEventName =
  | 'engine:initialized'
  | 'engine:pack-loaded'
  | 'engine:round-start'
  | 'engine:round-complete'
  | 'engine:round-error'
  | 'engine:sub-pipelines-done'
  | 'engine:state-changed'
  | 'engine:save-complete'
  | 'engine:save-error'
  | 'engine:config-changed'
  | 'engram:config-changed'
  | 'ai:request-start'
  | 'ai:stream-chunk'
  | 'ai:polish-chunk'
  | 'ai:response-complete'
  | 'ai:error'
  | 'pipeline:user-input'
  | 'pipeline:cancel'
  | 'ui:round-rendered'
  | 'ui:debug-prompt'
  | 'ui:debug-prompt-response'
  | 'ui:toast'
  | 'ui:modal'
  // Cloud auto-sync toggle changed anywhere (SavePanel / HomeView / auto-pause).
  // Payload: { enabled: boolean }. Lets every sync surface + CloudSyncManager keep
  // their local view of the toggle consistent without cross-component reactive wiring.
  | 'ui:cloud-autosync-changed'
  // Cloud repo format changed (v2→v3 after an explicit migration in CloudSlotsSection).
  // Payload: { format: 'v3' | 'v2' | 'empty' }. CloudSyncManager invalidates its
  // cached format so the auto-sync path switches pipelines without a reload.
  | 'ui:cloud-format-changed'
  | 'worldbook:updated'
  // Settings → LeftSidebar: Debug 模式 toggle changed. Payload: boolean (new value).
  // Sole consumer gates the Prompt Assembly panel entry's visibility.
  | 'settings:debug-mode-changed'
  // Canon Capture round result (SettingCaptureStage → UI). Payload: SettingCaptureResult.
  // The engine reports WHAT happened; the UI decides how to say it (i18n) and wires the
  // undo button — keeping engine code free of both i18n and Pinia.
  | 'settingCapture:result'
  // World-book selection outcome for the round (ContextAssembly → UI). Lets the panel
  // show WHY an entry was not injected; recomputing it in the UI would be a second
  // implementation of the budget rules, and the second one is the one that drifts.
  | 'worldbook:selection'
  // TTS playback state broadcast (TtsService → UI). Payload: TtsStateEvent.
  // Lets the play button, status-bar chip, and segment highlight stay in sync
  // without the UI holding a direct ref to the audio element.
  | 'tts:state'
  // TTS round-audio cache availability (TtsService → UI). Payload: TtsCacheEvent.
  // Tells the quick-switch download button whether the latest round's full
  // narration audio is cached and downloadable.
  | 'tts:cache'
  | string; // allow custom events

/**
 * An actionable button inside a toast.
 *
 * Added for Canon Capture's one-click undo, but deliberately generic: the same
 * capability serves any "we just did something for you — say so now or it stands"
 * moment (cloud-sync conflicts, degraded imports, …).
 *
 * The callback is a closure supplied by the emitter. It MUST NOT capture objects that
 * a rollback could invalidate — capture an id and re-read current state when clicked,
 * otherwise the button can act on a world that no longer exists.
 */
export interface ToastAction {
  /** i18n key for the button label. */
  i18nKey: string;
  /** Fallback label when the key is missing (engine code has no i18n runtime). */
  label?: string;
  /** Interpolation params for the label key. */
  i18nParams?: Record<string, unknown>;
  /** Invoked on click. The toast dismisses itself afterwards, success or failure. */
  onClick: () => void | Promise<void>;
  /** Visual weight. At most one `primary`. */
  variant?: 'primary' | 'secondary';
}

/** Payload for 'ui:toast' events */
export interface ToastPayload {
  type: 'info' | 'success' | 'warning' | 'error';
  message?: string;
  /** i18n key — Toast.vue will resolve via $t(). Engine code can emit this instead of a raw message. */
  i18nKey?: string;
  /** Interpolation params for the i18n key */
  i18nParams?: Record<string, unknown>;
  /** Deduplication id — toasts with the same id replace previous ones */
  id?: string;
  /** Auto-dismiss duration in ms. Defaults to 4000. Set 0 to disable auto-dismiss. */
  duration?: number;
  /**
   * Up to two buttons rendered inside the toast.
   *
   * Expiry semantics: letting an actionable toast time out means DECLINING the action —
   * nothing is invoked. That is the safe default for an undo affordance (doing nothing
   * keeps what was already recorded).
   */
  actions?: ToastAction[];
}

/** Hard cap on buttons per toast — more than two turns a hint into a dialog. */
export const MAX_TOAST_ACTIONS = 2;

/** Generic event handler — receives the payload and optionally returns a Promise */
export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;
