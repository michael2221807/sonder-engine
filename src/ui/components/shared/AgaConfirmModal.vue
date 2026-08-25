<script setup lang="ts">
/**
 * AgaConfirmModal — replaces window.confirm with an AGA-styled dialog.
 *
 * Teleports to <body>; traps focus; Escape to cancel; guarded backdrop press
 * to cancel (pointerdown AND pointerup must both land on the backdrop — a drag
 * that starts inside the dialog can never dismiss it).
 */
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import { useBackdropClose } from '@/ui/composables/useBackdropClose';
defineProps<{
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'primary' | 'danger';
}>();

const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

const dialogRef = ref<HTMLElement | null>(null);

function confirm() { emit('confirm'); }
function cancel() { emit('cancel'); }

const backdrop = useBackdropClose(cancel);

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') cancel();
}

onMounted(async () => {
  document.addEventListener('keydown', onKeydown);
  await nextTick();
  const firstBtn = dialogRef.value?.querySelector<HTMLButtonElement>('button');
  firstBtn?.focus();
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div
      class="aga-confirm-overlay"
      @pointerdown="backdrop.onPointerdown"
      @pointerup="backdrop.onPointerup"
    >
      <div ref="dialogRef" class="aga-confirm-dialog" role="dialog" :aria-label="title ?? $t('modal.confirm.ariaDialog')">
        <h3 v-if="title" class="aga-confirm__title">{{ title }}</h3>
        <p class="aga-confirm__message">{{ message }}</p>
        <div class="aga-confirm__actions">
          <button class="aga-confirm__btn aga-confirm__btn--cancel" @click="cancel">
            {{ cancelLabel ?? $t('modal.confirm.defaultCancel') }}
          </button>
          <button
            class="aga-confirm__btn"
            :class="variant === 'danger' ? 'aga-confirm__btn--danger' : 'aga-confirm__btn--confirm'"
            @click="confirm"
          >
            {{ confirmLabel ?? $t('modal.confirm.defaultConfirm') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Sanctuary migration 2026-04-21:
   - Backdrop `rgba(0,0,0,0.5)` + 2px blur → warm-charcoal fog + 6px blur
     (matches Modal.vue Phase 3.1 language)
   - Dialog panel: solid surface → frosted cabin-glass (72% surface + 32px
     blur + saturate + inset refraction highlight)
   - Title: adds CJK serif + tracked letter-spacing
   - Message: CJK serif body + loose line-height
   - Confirm / danger buttons: filled + #fff → sage-muted beacon /
     warm-rust muted (matches AgaButton new language) */

/* 2026-04-21 tuning (see Modal.vue): overlay α lowered so frosted glass
   actually shows page content softened through the pane; dialog uses a
   subtle vertical gradient + stronger blur + top/bottom edge highlights
   for real cabin-glass refraction. */
.aga-confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--glass-overlay-bg);
  backdrop-filter: var(--glass-overlay-blur);
  -webkit-backdrop-filter: var(--glass-overlay-blur);
}

.aga-confirm-dialog {
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: none;
  border-radius: var(--radius-xl);
  padding: var(--space-xl);
  max-width: 400px;
  width: 90%;
  box-shadow: var(--glass-shadow);
}

.aga-confirm__title {
  font-family: var(--font-serif-cjk);
  font-size: var(--font-size-lg);
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--color-text);
  margin-bottom: var(--space-sm);
}

.aga-confirm__message {
  font-family: var(--font-serif-cjk);
  font-size: var(--font-size-md);
  color: var(--color-text-secondary);
  line-height: var(--line-height-loose);
  letter-spacing: 0.01em;
  margin-bottom: var(--space-xl);
}

.aga-confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
}

.aga-confirm__btn {
  padding: var(--space-xs) var(--space-lg);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-family: var(--font-sans);
  font-weight: 500;
  letter-spacing: 0.04em;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background-color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}

.aga-confirm__btn--cancel {
  background: transparent;
  border-color: var(--color-border);
  color: var(--color-text-secondary);
}
.aga-confirm__btn--cancel:hover {
  background: color-mix(in oklch, var(--color-text) 4%, transparent);
  color: var(--color-text);
}

.aga-confirm__btn--confirm {
  background: var(--color-sage-muted);
  border-color: color-mix(in oklch, var(--color-sage-400) 35%, transparent);
  color: var(--color-sage-100);
}
.aga-confirm__btn--confirm:hover {
  background: color-mix(in oklch, var(--color-sage-400) 22%, transparent);
  border-color: var(--color-sage-400);
  box-shadow:
    0 0 16px color-mix(in oklch, var(--color-sage-400) 28%, transparent),
    inset 0 0 12px color-mix(in oklch, var(--color-sage-400) 12%, transparent);
}

.aga-confirm__btn--danger {
  background: color-mix(in oklch, var(--color-danger) 14%, transparent);
  border-color: color-mix(in oklch, var(--color-danger) 45%, transparent);
  color: color-mix(in oklch, var(--color-danger) 95%, var(--color-text));
}
.aga-confirm__btn--danger:hover {
  background: color-mix(in oklch, var(--color-danger) 22%, transparent);
  border-color: color-mix(in oklch, var(--color-danger) 60%, transparent);
  box-shadow:
    0 0 14px color-mix(in oklch, var(--color-danger) 25%, transparent),
    inset 0 0 10px color-mix(in oklch, var(--color-danger) 12%, transparent);
}
</style>
