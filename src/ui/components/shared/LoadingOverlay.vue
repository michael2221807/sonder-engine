<template>
  <!--
    Loading overlay — either fullscreen (Teleported to body) or
    container-scoped (positioned absolute within the parent).

    Polanyi principle: the spinner is subsidiary awareness indicating
    "something is happening" without requiring the user to interpret
    complex progress bars. The optional message provides just enough
    focal context when needed.
  -->
  <Teleport to="body" :disabled="!fullscreen">
    <Transition name="loading-fade">
      <div
        v-if="visible"
        :class="['loading-overlay', { 'loading-overlay--fullscreen': fullscreen }]"
        role="status"
        :aria-label="message || $t('common.loading.ariaDefault')"
        aria-live="assertive"
      >
        <div class="loading-content">
          <!-- Spinner — three orbiting dots for organic "breathing" feel -->
          <div class="spinner" aria-hidden="true">
            <div class="spinner__ring">
              <div class="spinner__dot spinner__dot--1" />
              <div class="spinner__dot spinner__dot--2" />
              <div class="spinner__dot spinner__dot--3" />
            </div>
          </div>

          <!-- Optional message text -->
          <p v-if="message" class="loading-message">{{ message }}</p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
interface LoadingOverlayProps {
  visible: boolean;
  message?: string;
  fullscreen?: boolean;
}

withDefaults(defineProps<LoadingOverlayProps>(), {
  message: '',
  fullscreen: false,
});
</script>

<style scoped>
/* Sanctuary migration 2026-04-21:
   - Plate-black `rgba(15,15,20,X)` backdrop → warm-charcoal color-mix
     of `--color-bg` so the overlay reads as fog settling on the same
     warm palette as the rest of the app, not cold black plastic
   - Spinner dots: raw `--color-primary` → sage-400 + sage halo
   - Spinner animation tempo: 1.8s → 2.4s (sanctuary slower cadence) and
     `spinner-pulse` replaced with the shared `sanctuary-breath` rhythm
     used by typing-indicator + AgaLoader (one tempo across the app)
   - Message: serif font + letter-spacing; breathing opacity tempo
     lifted to `--duration-breath` */

.loading-overlay {
  position: absolute;
  inset: 0;
  z-index: 8000;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(ellipse 60% 50% at 50% 50%,
      color-mix(in oklch, var(--color-bg) 55%, transparent) 0%,
      color-mix(in oklch, var(--color-bg) 72%, transparent) 100%);
  backdrop-filter: blur(8px) saturate(1.05);
  -webkit-backdrop-filter: blur(8px) saturate(1.05);
}

.loading-overlay--fullscreen {
  position: fixed;
  z-index: 9500;
  background:
    radial-gradient(ellipse 60% 50% at 50% 50%,
      color-mix(in oklch, var(--color-bg) 62%, transparent) 0%,
      color-mix(in oklch, var(--color-bg) 80%, transparent) 100%);
  backdrop-filter: blur(12px) saturate(1.05);
  -webkit-backdrop-filter: blur(12px) saturate(1.05);
}

.loading-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

/* ── Spinner: three sage dots orbiting with a breathing rhythm ── */
.spinner {
  position: relative;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.spinner::before {
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 15%, transparent);
  box-shadow: 0 0 16px color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  animation: lumi-pulse var(--lumi-pulse, 5s) ease-in-out infinite;
}

.spinner__ring {
  position: relative;
  width: 40px;
  height: 40px;
  animation: spinner-rotate 2.4s linear infinite;
}

.spinner__dot {
  position: absolute;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-sage-400);
  box-shadow:
    0 0 8px color-mix(in oklch, var(--color-sage-400) 50%, transparent),
    0 0 16px color-mix(in oklch, var(--color-sage-400) 25%, transparent),
    inset 0 1px 2px rgba(255, 255, 255, 0.2);
}

.spinner__dot--1 {
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  animation: sanctuary-breath var(--duration-breath) var(--ease-out) infinite;
}
.spinner__dot--2 {
  bottom: 4px;
  left: 4px;
  animation: sanctuary-breath var(--duration-breath) var(--ease-out) 530ms infinite;
  opacity: 0.75;
}
.spinner__dot--3 {
  bottom: 4px;
  right: 4px;
  animation: sanctuary-breath var(--duration-breath) var(--ease-out) 1060ms infinite;
  opacity: 0.5;
}

@keyframes spinner-rotate {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

@keyframes sanctuary-breath {
  0%, 100% { opacity: 0.35; transform: scale(0.85); }
  50%      { opacity: 1;    transform: scale(1.05); }
}

/* ── Message ── */
.loading-message {
  margin: 0;
  font-family: var(--font-serif-cjk);
  font-size: 0.875rem;
  letter-spacing: 0.04em;
  color: var(--color-text-secondary);
  text-align: center;
  max-width: 280px;
  line-height: 1.6;
  animation: loading-text-breath var(--duration-breath) var(--ease-out) infinite;
}

@keyframes loading-text-breath {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.65; }
}

/* ── Fade transition ── */
.loading-fade-enter-active { transition: opacity var(--duration-normal) var(--ease-out); }
.loading-fade-leave-active { transition: opacity var(--duration-fast) var(--ease-out); }
.loading-fade-enter-from,
.loading-fade-leave-to { opacity: 0; }
</style>
