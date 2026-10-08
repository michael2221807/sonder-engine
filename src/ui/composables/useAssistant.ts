// App doc: docs/user-guide/pages/game-assistant.md
/**
 * useAssistant — Vue composable wrapping AssistantService for Vue components
 *
 * Handles:
 * - Reactive session state (loaded from store)
 * - Send / clear / inject / rollback wrappers
 * - Stream chunk accumulation into reactive ref
 * - Settings persistence to localStorage
 *
 * 对应 docs/status/plan-assistant-utility-2026-04-14.md Phase 5b。
 */
import { ref, computed, onMounted, onUnmounted, type Ref } from 'vue';
import { injectService } from '@/ui/injection-keys';
import { useI18n } from 'vue-i18n';
import type {
  AssistantSendError,
} from '@/engine/services/assistant/assistant-service';
import type {
  AssistantMessage,
  AssistantSession,
  AttachmentSpec,
  PayloadDraft,
} from '@/engine/services/assistant/types';
import { eventBus } from '@/engine/core/event-bus';

const SETTINGS_KEY = 'aga_assistant_settings';
const SESSION_ID = 'default';

export function useAssistant() {
  const { t } = useI18n();
  const service = injectService('assistantService');
  if (!service) {
    throw new Error('[useAssistant] AssistantService not provided');
  }

  // ─── Reactive session state ───────────────────────

  const session = ref<AssistantSession>({
    sessionId: SESSION_ID,
    createdAt: Date.now(),
    messages: [],
  });

  /** Live-streaming chunk for the in-progress assistant message */
  const streamingContent = ref<string>('');

  /** Whether send() is in flight (UI uses to disable input) */
  const isSending = ref(false);

  /** Whether canRollback (mirrors service state) */
  const canRollback = ref(false);

  async function refreshSession(): Promise<void> {
    session.value = await service!.getSession(SESSION_ID);
    canRollback.value = service!.canRollbackInject();
  }

  const eventCleanups: Array<() => void> = [];
  onMounted(() => {
    void refreshSession();
    eventCleanups.push(eventBus.on('assistant:payload-injected', () => { void refreshSession(); }));
    eventCleanups.push(eventBus.on('assistant:payload-rolled-back', () => { void refreshSession(); }));
    eventCleanups.push(eventBus.on('assistant:payload-inject-failed', () => { void refreshSession(); }));
  });
  onUnmounted(() => { eventCleanups.forEach(fn => fn()); });

  // ─── Actions ──────────────────────────────────────

  async function send(prompt: string, attachments: AttachmentSpec[]): Promise<void> {
    if (isSending.value) return;
    isSending.value = true;
    streamingContent.value = '';
    try {
      await service!.send({
        sessionId: SESSION_ID,
        prompt,
        attachments,
        onStreamChunk: (_chunk, accumulated) => {
          streamingContent.value = accumulated;
        },
      });
    } catch (err) {
      const e = err as AssistantSendError | Error;
      eventBus.emit('ui:toast', {
        type: 'error',
        message: t('assistant.toast.sendFailed', { error: e.message ?? String(err) }),
        duration: 4000,
      });
    } finally {
      isSending.value = false;
      streamingContent.value = '';
      await refreshSession();
    }
  }

  async function clear(): Promise<void> {
    await service!.clear(SESSION_ID);
    await refreshSession();
    eventBus.emit('ui:toast', { type: 'info', message: t('assistant.toast.conversationCleared'), duration: 1500 });
  }

  async function applyPayload(messageId: string, draft: PayloadDraft): Promise<void> {
    const result = await service!.applyPayload(SESSION_ID, messageId, draft);
    if (result.ok) {
      eventBus.emit('ui:toast', {
        type: 'success',
        message: t('assistant.toast.patchInjected', { count: result.patchCount }),
        duration: 2500,
      });
      if (draft.raw.knowledgeFacts?.length && !draft.knowledgeFactsProcessed) {
        eventBus.emit('ui:toast', {
          type: 'warning',
          message: t('assistant.toast.engramDisabled'),
          duration: 4000,
        });
      }
    } else {
      eventBus.emit('ui:toast', {
        type: 'error',
        message: t('assistant.toast.injectFailed', { error: result.error }),
        duration: 4000,
      });
    }
    await refreshSession();
  }

  async function rollback(): Promise<void> {
    const result = await service!.rollbackLastInject(SESSION_ID);
    if (result.ok) {
      eventBus.emit('ui:toast', { type: 'success', message: t('assistant.toast.rollbackSuccess'), duration: 2000 });
    } else {
      eventBus.emit('ui:toast', { type: 'warning', message: result.error ?? t('assistant.toast.rollbackFailed'), duration: 2500 });
    }
    await refreshSession();
  }

  // ─── Settings ─────────────────────────────────────

  const settings = ref(service.getSettings());

  function updateSettings(patch: Partial<typeof settings.value>): void {
    service!.updateSettings(patch);
    settings.value = service!.getSettings();
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.value)); } catch { /* ignore */ }
  }

  // ─── World-builder mode helpers (Story 3) ─────────

  /**
   * Story 3: recommended default context attachments for world-builder
   * free-chat (relationships / locations / world description). Delegates to
   * the service-owned AttachmentBuilder so the UI doesn't hardcode scopes.
   */
  function suggestWorldBuilderAttachments(paths: {
    relationships: string;
    locations: string;
    worldDescription: string;
  }): AttachmentSpec[] {
    return service!.suggestWorldBuilderAttachments(paths);
  }

  // ─── Derived ──────────────────────────────────────

  const messages = computed<AssistantMessage[]>(() => session.value.messages);

  return {
    // state
    session,
    messages,
    streamingContent: streamingContent as Readonly<Ref<string>>,
    isSending,
    canRollback,
    settings,
    // actions
    send,
    clear,
    applyPayload,
    rollback,
    refreshSession,
    updateSettings,
    suggestWorldBuilderAttachments,
  };
}
