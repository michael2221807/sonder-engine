<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.15.1
/**
 * CapturedSettingNotifier — turns a capture result into the right thing to say.
 *
 * Mounted once beside `<Toast />` in App.vue (same pattern as CloudSyncManager). It is a
 * UI component rather than engine code because it needs i18n, the router, and the
 * coordinator — none of which belong inside a pipeline stage.
 *
 * The four states exist because collapsing them lies to the player. In particular,
 * re-stating a setting that is already recorded produces `accepted === 0`, and reporting
 * that as "could not record" is actively wrong: the setting IS recorded, it was recorded
 * earlier. See design §6.4.
 *
 * The undo button is the reason toasts grew actions at all: a mis-captured setting is
 * permanent pollution, and the only moment the player is looking at it is the few
 * seconds the toast is on screen. Making them navigate to a panel to undo means, in
 * practice, that they never will.
 */
import { onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { eventBus } from '@/engine/core/event-bus';
import type { ToastAction } from '@/engine/types';
import type { SettingCaptureResult } from '@/engine/pipeline/stages/setting-capture';
import { useCapturedSettings } from '@/ui/composables/useCapturedSettings';
import { MAX_ACTIVE_CAPTURED_ENTRIES } from '@/engine/prompt/captured-entry-mutations';

const { t } = useI18n();
const router = useRouter();
const { coordinator } = useCapturedSettings();

/** Open the world-book tab, optionally with text to pre-fill a manual entry. */
function openWorldBook(prefill?: string): void {
  void router.push({
    path: '/game/prompts',
    query: {
      tab: 'worldbook',
      ...(prefill ? { capturedDraft: prefill } : {}),
    },
  }).catch(() => { /* duplicate / guarded navigation — nothing to recover */ });
}

function viewAction(): ToastAction {
  return {
    i18nKey: 'mainGame.settingCapture.view',
    variant: 'secondary',
    onClick: () => openWorldBook(),
  };
}

/**
 * Undo every entry this round created.
 *
 * Captures only entry IDS, never entry objects: by the time the player clicks, a
 * rollback may have replaced the whole state tree, and acting on a stale object would
 * write a ghost back into the book.
 */
function undoAction(entryIds: string[]): ToastAction {
  return {
    i18nKey: 'mainGame.settingCapture.undo',
    variant: 'primary',
    onClick: async () => {
      let undone = 0;
      let alreadyGone = 0;
      for (const id of entryIds) {
        const r = await coordinator.retract(id);
        if (r.ok) undone += 1;
        // The player may have hit 回退 (round rollback) inside the toast's 10s window —
        // the slot book rolled back with the tree and the entry no longer exists. From
        // their point of view the setting IS undone; reporting "could not save" for the
        // outcome they wanted would be a lie.
        else if (r.reason === 'not_found' || r.reason === 'no_book') alreadyGone += 1;
      }
      const success = undone > 0 || alreadyGone === entryIds.length;
      eventBus.emit('ui:toast', {
        type: success ? 'info' : 'warning',
        i18nKey: success
          ? 'mainGame.settingCapture.undone'
          : 'prompt.settingCapture.mutationFailed',
        message: success
          ? t('mainGame.settingCapture.undone')
          : t('prompt.settingCapture.mutationFailed'),
        duration: 2500,
      });
    },
  };
}

function handleResult(payload: unknown): void {
  const r = payload as SettingCaptureResult;
  // An ordinary round says nothing at all — the feature must be invisible when unused.
  if (!r || !r.hadTag) return;

  const accepted = r.accepted ?? [];
  const noops = r.noops ?? [];
  const rejected = r.rejected ?? [];

  if (accepted.length > 0) {
    const ids = accepted.map((a) => a.entryId);
    const partial = rejected.length > 0;
    const key = partial
      ? 'mainGame.settingCapture.recordedPartial'
      : 'mainGame.settingCapture.recorded';
    const params = { count: accepted.length, failed: rejected.length };

    eventBus.emit('ui:toast', {
      type: 'success',
      i18nKey: key,
      i18nParams: params,
      message: t(key, params),
      actions: [undoAction(ids), viewAction()],
    });
    return;
  }

  if (noops.length > 0) {
    // Already recorded. This is a SUCCESS state wearing a zero — never call it a failure.
    eventBus.emit('ui:toast', {
      type: 'info',
      i18nKey: 'mainGame.settingCapture.alreadyKnown',
      message: t('mainGame.settingCapture.alreadyKnown'),
      actions: [viewAction()],
    });
    return;
  }

  // The player asked for something to be remembered and nothing was. Say so, and offer
  // the manual route pre-filled with what they wrote — silence here is the failure mode
  // this project has been bitten by before (Story 7's openingDegraded).
  const capacityHit = rejected.some((x) => x.reason === 'capacity');
  const prefill = (r.segments ?? []).map((s) => s.rawText).join('\n').trim();

  eventBus.emit('ui:toast', {
    type: 'warning',
    i18nKey: capacityHit
      ? 'mainGame.settingCapture.capacityFull'
      : 'mainGame.settingCapture.failed',
    i18nParams: capacityHit ? { max: MAX_ACTIVE_CAPTURED_ENTRIES } : undefined,
    message: capacityHit
      ? t('mainGame.settingCapture.capacityFull', { max: MAX_ACTIVE_CAPTURED_ENTRIES })
      : t('mainGame.settingCapture.failed'),
    // 15s, not the 10s default: this toast reports that the player's EXPLICIT request
    // failed, and a player mid-way through a long reply needs the extra window. The
    // panel banner now carries the same information permanently either way.
    duration: 15000,
    actions: [
      {
        i18nKey: 'mainGame.settingCapture.addManually',
        variant: 'primary',
        onClick: () => openWorldBook(prefill || undefined),
      },
    ],
  });
}

let unsubscribe: (() => void) | null = null;

onMounted(() => {
  unsubscribe = eventBus.on('settingCapture:result', handleResult);
});

onUnmounted(() => {
  unsubscribe?.();
});
</script>

<template>
  <!-- Headless: it only listens and emits toasts. -->
  <span class="sr-only" aria-hidden="true" />
</template>

<style scoped>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
