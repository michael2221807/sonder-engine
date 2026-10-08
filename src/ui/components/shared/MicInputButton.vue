<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.14 (语音输入 · STT)
/**
 * MicInputButton — 自包含的语音输入控件,可复用于任意输入框(主输入 / NPC 私聊)。
 *
 * 双模式(读 aga_stt_settings 决定):
 *   - 实时听写(stream):WebSocket + 16k PCM,partial 实时上屏、final 句尾定稿(iOS 听写体验)。
 *   - 录音转写(record):MediaRecorder 录完 → 一次性转写 → 回填。
 *   - 自动(auto):有流式服务用 stream,否则回落 record。
 *
 * 与父容器解耦:通过 v-model 读写输入文本,通过 `textarea` prop 拿到光标位置,把识别文本
 * 插入光标处(不覆盖已敲的字)。录音期间只占用自身按钮位(紧凑控件:取消/电平/计时/停止),
 * textarea 常驻可见 → 两种模式行为一致、可直接落进任何输入行。
 *
 * gated:仅当 设置启用 + sttService.isReady() + 浏览器支持 时显示麦克风键(非死控件)。
 */
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { injectService } from '@/ui/injection-keys';
import { useI18n } from 'vue-i18n';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { eventBus } from '@/engine/core/event-bus';
import { loadSttSettings } from '@/engine/stt/stt-settings';
import { useAPIManagementStore } from '@/engine/stores/engine-api';
import { useSttLexicon } from '@/ui/composables/useSttLexicon';
import { VAD_MAX_SILENCE_MS } from '@/engine/stt/types';
import type { SttStreamHandle, SttLatencyProfile } from '@/engine/stt/types';

const props = withDefaults(defineProps<{
  modelValue: string;
  textarea?: HTMLTextAreaElement | null;
  disabled?: boolean;
}>(), {
  textarea: null,
  disabled: false,
});
const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'recording-change', active: boolean): void;
}>();

const { t } = useI18n();
const stt = injectService('sttService', undefined);
const lexicon = useSttLexicon();
// 本次录音的快照(开录时定;流式握手用)。热词:偏置关或无词 → ''。停顿容忍:映射自设置。
let sessionHotwords = '';
let sessionVadMs = 0;

// ── 可见性(gated,响应设置 + API 配置变化) ──
// enabled 响应设置开关(经 aga:stt-settings-changed 刷新);sttConfigured 直接读
// pinia store 的 apiConfigs → 用户在 API 面板加/删/启停 STT 配置时立即重算,麦克风
// 键无需刷新页面即出现/消失(修:此前依赖非响应式的 stt.isReady() 计算,配置变了不更新)。
const apiStore = useAPIManagementStore();
const enabled = ref(loadSttSettings().enabled);
const mediaSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
const sttConfigured = computed(() =>
  apiStore.apiConfigs.some((c) => c.enabled && (c.apiCategory ?? 'llm') === 'stt'));
const visible = computed(() => enabled.value && mediaSupported && sttConfigured.value);

function refreshEnabled(): void {
  enabled.value = loadSttSettings().enabled;
}

// ── 状态机 ──
type State = 'idle' | 'listening' | 'finalizing' | 'transcribing';
const state = ref<State>('idle');
const activeMode = ref<'stream' | 'record'>('record');
const isActive = computed(() => state.value !== 'idle');

// 插入锚点(录音开始时快照)
let base = '';
let before = '';
let after = '';
let committed = ''; // 已定稿累积(stream 多句 / record 单次)

// 会话令牌:每次 start()/cancel() 递增,在途异步回调(getUserMedia/transcribe/WS
// 回调)以捕获的旧值与当前值比对,不符即 no-op → 杜绝取消/替换后的串档(reviewer #1/#2)。
let sessionId = 0;
// stream
let streamHandle: SttStreamHandle | null = null;
// record
let recStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let recChunks: BlobPart[] = [];
let recAbort: AbortController | null = null;
// analyser(record 波形)
let analyserCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let rafId: number | null = null;
// 计时
const elapsed = ref(0);
let timerId: ReturnType<typeof setInterval> | null = null;
// 波形电平(0..1 的滚动数组)
const WAVE_BARS = 22;
const levels = ref<number[]>(new Array(WAVE_BARS).fill(0.08));

function pushLevel(l: number): void {
  const v = Math.min(1, Math.max(0.08, l * 3.2)); // rms 偏小,放大到可视
  const arr = levels.value.slice(1);
  arr.push(v);
  levels.value = arr;
}
function resetWave(): void {
  levels.value = new Array(WAVE_BARS).fill(0.08);
}

const timerLabel = computed(() => {
  const m = String(Math.floor(elapsed.value / 60)).padStart(2, '0');
  const s = String(elapsed.value % 60).padStart(2, '0');
  return `${m}:${s}`;
});
function startTimer(): void {
  elapsed.value = 0;
  timerId = setInterval(() => { elapsed.value += 1; }, 1000);
}
function stopTimer(): void {
  if (timerId) { clearInterval(timerId); timerId = null; }
}

// ── 文本插入 ──
// before/after 在 captureAnchor 时快照,录音期间父级 textarea 被置 readonly(经
// recording-change → 见 GameComposer/NpcChatModal),故快照不会被并发编辑作废
// (reviewer #3)。partial 刷新不抢焦点(focusEnd=false),只在已聚焦时移光标;定稿/
// 录音回填 focusEnd=true 才聚焦一次。
function applyText(mid: string, focusEnd = false): void {
  emit('update:modelValue', before + mid + after);
  const caret = (before + mid).length;
  nextTick(() => {
    const el = props.textarea;
    if (!el) return;
    if (focusEnd) el.focus();
    if (focusEnd || document.activeElement === el) {
      try { el.setSelectionRange(caret, caret); } catch { /* ignore */ }
    }
  });
}

function captureAnchor(): void {
  base = props.modelValue;
  const el = props.textarea;
  const start = el && typeof el.selectionStart === 'number' ? el.selectionStart : base.length;
  const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
  before = base.slice(0, start);
  after = base.slice(end);
  committed = '';
}

// ── 启动 ──
async function start(): Promise<void> {
  if (isActive.value || props.disabled || !stt) return;
  const mySession = ++sessionId;
  // 同步离开 idle → 立刻挡住重入(reviewer #4:record 路径在 getUserMedia 前也不会被二次点击)。
  state.value = 'listening';
  const s = loadSttSettings();
  sessionHotwords = lexicon.getHotwords(); // 专有名词热词快照(偏置关或无词 → '')
  sessionVadMs = VAD_MAX_SILENCE_MS[s.pauseTolerance]; // 停顿容忍 → vad_max_silence_ms(仅流式用)
  captureAnchor();
  emit('recording-change', true);
  const useStream = s.mode === 'stream' || (s.mode === 'auto' && stt.isStreamReady());
  if (useStream) startStream(s.latency, mySession);
  else void startRecord(mySession);
}

/** 当前会话是否仍有效(未被 cancel/新 start 取代)。 */
function isCurrent(session: number): boolean {
  return session === sessionId;
}

// ── 实时听写(stream) ──
function startStream(latency: SttLatencyProfile, session: number): void {
  activeMode.value = 'stream';
  resetWave();
  startTimer();
  const handle = stt!.startStream({
    onOpen: () => { /* 已可说话 */ },
    onPartial: (text) => { if (isCurrent(session) && state.value !== 'idle') applyText(committed + text); },
    onFinal: (text) => { if (!isCurrent(session)) return; committed += text; applyText(committed); },
    onLevel: (l) => { if (isCurrent(session)) pushLevel(l); },
    onError: (err) => { if (isCurrent(session)) showStreamErrorToast(err); }, // 只弹提示;清理归 onClose(reviewer #5)
    onClose: () => finalizeStream(session),
  }, { latency, hotwords: sessionHotwords, vadMaxSilenceMs: sessionVadMs });
  if (!handle) {
    // 无可用流式配置 → 回落录音转写
    stopTimer();
    void startRecord(session);
  } else {
    streamHandle = handle;
  }
}
/** 会话终点单一清理入口(onClose 唯一拥有者)。 */
function finalizeStream(session: number): void {
  if (!isCurrent(session)) return; // 已被 cancel/替换 → 由 cancel 负责收尾
  stopTimer();
  streamHandle = null;
  applyText(committed, true); // 丢弃残留 partial,只保留定稿并聚焦
  state.value = 'idle';
  emit('recording-change', false);
}
/** 仅展示 toast,不动状态(状态清理由 onClose→finalizeStream 唯一负责)。 */
function showStreamErrorToast(err: Error): void {
  const key = err.message === 'MIC_PERMISSION_DENIED' ? 'stt.error.permission'
    : err.message === 'MIC_NOT_FOUND' ? 'stt.error.noMic'
    : err.message === 'MIC_NOT_SUPPORTED' ? 'stt.error.notSupported'
    : 'stt.error.stream';
  eventBus.emit('ui:toast', { type: 'error', i18nKey: key, message: t(key), duration: 3200 });
}

// ── 录音转写(record) ──
async function startRecord(session: number): Promise<void> {
  activeMode.value = 'record';
  recChunks = [];
  recAbort = new AbortController();
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    return toastMediaError(err, session);
  }
  // getUserMedia 期间可能已被 cancel/替换 → 立刻释放本次流,不接管(reviewer #2/#4)。
  if (!isCurrent(session) || props.disabled) {
    recStream.getTracks().forEach((tk) => tk.stop());
    recStream = null;
    if (isCurrent(session)) { state.value = 'idle'; emit('recording-change', false); }
    return;
  }
  setupAnalyser(recStream);
  startTimer();
  const mime = pickMime();
  try {
    mediaRecorder = mime ? new MediaRecorder(recStream, { mimeType: mime }) : new MediaRecorder(recStream);
  } catch {
    teardownAnalyser();
    stopTracks();
    stopTimer();
    state.value = 'idle';
    emit('recording-change', false);
    return failToast('stt.error.notSupported');
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = () => void onRecordStop(session);
  mediaRecorder.start();
}
async function onRecordStop(session: number): Promise<void> {
  stopTimer();
  teardownAnalyser();
  stopTracks();
  if (!isCurrent(session)) return; // 已取消/替换 → 丢弃这次录音,不动 UI(reviewer #2)
  state.value = 'transcribing';
  const type = (recChunks[0] as Blob | undefined)?.type || 'audio/webm';
  const blob = new Blob(recChunks, { type });
  try {
    const text = await stt!.transcribe(blob, { signal: recAbort?.signal, hotwords: sessionHotwords }); // 可被 cancel 中止(reviewer #1)
    if (!isCurrent(session)) return; // 转写期间被取消 → 不回填,避免覆盖用户已输入
    committed = text || '';
    applyText(committed, true);
    state.value = 'idle';
    emit('recording-change', false);
  } catch {
    if (!isCurrent(session)) return; // 中止(AbortError)或已替换 → 静默
    state.value = 'idle';
    applyText(committed, true);
    emit('recording-change', false);
    failToast('stt.error.backend');
  }
}

// ── 停止 / 取消 ──
function stop(): void {
  if (activeMode.value === 'stream') {
    if (state.value === 'listening') {
      state.value = 'finalizing';
      streamHandle?.stop(); // 等末尾 final → onClose → finalizeStream
    }
  } else if (state.value === 'listening') {
    mediaRecorder?.stop(); // → onstop → transcribe
  }
}
function cancel(): void {
  // 先作废会话令牌:所有在途回调(WS onClose、getUserMedia、transcribe)随即 no-op(reviewer #1/#2/#5)。
  sessionId += 1;
  if (activeMode.value === 'stream') {
    streamHandle?.cancel();
    streamHandle = null;
    stopTimer();
  } else {
    recAbort?.abort(); // 中止在途转写请求
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    else { teardownAnalyser(); stopTracks(); stopTimer(); }
  }
  // 还原到录音前(此后无回调能再改 modelValue)。
  emit('update:modelValue', base);
  state.value = 'idle';
  emit('recording-change', false);
  nextTick(() => props.textarea?.focus());
}

function onMicClick(): void {
  if (state.value === 'idle') void start();
  else if (state.value === 'listening') stop();
}

// ── 波形 analyser(record 模式) ──
function setupAnalyser(stream: MediaStream): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    analyserCtx = new Ctx();
    const src = analyserCtx.createMediaStreamSource(stream);
    analyser = analyserCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const loop = (): void => {
      if (!analyser) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      pushLevel(Math.sqrt(sum / data.length));
      rafId = requestAnimationFrame(loop);
    };
    loop();
  } catch { /* 波形不是关键路径,失败忽略 */ }
}
function teardownAnalyser(): void {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (analyserCtx && analyserCtx.state !== 'closed') analyserCtx.close().catch(() => {});
  analyserCtx = null;
  analyser = null;
}
function stopTracks(): void {
  recStream?.getTracks().forEach((tk) => tk.stop());
  recStream = null;
}

function pickMime(): string {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of cands) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* ignore */ } }
  return '';
}
function toastMediaError(err: unknown, session: number): void {
  if (!isCurrent(session)) return;
  emit('recording-change', false);
  state.value = 'idle';
  const name = err instanceof Error ? err.name : '';
  const key = name === 'NotAllowedError' || name === 'SecurityError' ? 'stt.error.permission'
    : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'stt.error.noMic'
    : 'stt.error.backend';
  failToast(key);
}
function failToast(key: string): void {
  eventBus.emit('ui:toast', { type: 'error', i18nKey: key, message: t(key), duration: 3200 });
}

const micTip = computed(() => (activeMode.value === 'stream' ? t('stt.mic.stopStream') : t('stt.mic.stopRecord')));
const statusLabel = computed(() => {
  if (state.value === 'transcribing') return t('stt.mic.transcribing');
  if (state.value === 'finalizing') return t('stt.mic.finalizing');
  return activeMode.value === 'stream' ? t('stt.mic.dictating') : t('stt.mic.listening');
});

onMounted(() => {
  window.addEventListener('aga:stt-settings-changed', refreshEnabled);
});
onBeforeUnmount(() => {
  window.removeEventListener('aga:stt-settings-changed', refreshEnabled);
  // 卸载时兜底清理
  if (isActive.value) cancel();
  stopTimer();
  teardownAnalyser();
});
</script>

<template>
  <div v-if="visible" class="mic-input" :class="{ 'mic-input--active': isActive }">
    <!-- idle:麦克风键 -->
    <Tooltip v-if="state === 'idle'" :text="$t('stt.mic.start')" interactive>
      <button
        class="mic-btn"
        :disabled="props.disabled"
        :aria-label="$t('stt.mic.start')"
        @click="onMicClick"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
        </svg>
      </button>
    </Tooltip>

    <!-- listening / finalizing / transcribing:紧凑录音控件 -->
    <div
      v-else
      class="rec-control"
      :class="{ 'rec-control--stream': activeMode === 'stream', 'rec-control--busy': state === 'transcribing' || state === 'finalizing' }"
      role="status"
      aria-live="polite"
    >
      <Tooltip :text="$t('stt.mic.cancel')" interactive>
        <button
          class="rec-cancel"
          :aria-label="$t('stt.mic.cancel')"
          @click="cancel"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true">
            <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </Tooltip>

      <span class="rec-dot" aria-hidden="true" />
      <span class="rec-status">{{ statusLabel }}</span>

      <!-- 波形(转写/定稿中换成流光) -->
      <div v-if="state === 'listening'" class="wave" aria-hidden="true">
        <i v-for="(lv, i) in levels" :key="i" :style="{ height: Math.round(lv * 100) + '%' }" />
      </div>
      <div v-else class="shimmer" aria-hidden="true" />

      <span class="rec-timer">{{ timerLabel }}</span>

      <Tooltip v-if="state === 'listening'" :text="micTip" interactive>
        <button class="rec-stop" :aria-label="micTip" @click="stop">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
        </button>
      </Tooltip>
    </div>
  </div>
</template>

<style scoped>
.mic-input { display: inline-flex; align-items: flex-end; }

/* idle 麦克风键 — 复用 composer 的 sage 语气 */
.mic-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  background: transparent;
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 40%, transparent);
  border-radius: var(--radius-lg);
  color: var(--color-sage-300);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}
.mic-btn:hover:not(:disabled) {
  color: var(--color-sage-100);
  background: var(--color-sage-muted);
  border-color: var(--color-sage-400);
  box-shadow: 0 0 14px color-mix(in oklch, var(--color-sage-400) 22%, transparent);
}
.mic-btn:disabled { opacity: 0.35; cursor: not-allowed; }

/* 录音中紧凑控件 */
.rec-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 8px;
  border-radius: var(--radius-lg);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  background: linear-gradient(180deg,
    color-mix(in oklch, var(--color-sage-400) 8%, var(--color-surface-input)),
    var(--color-surface-input));
  box-shadow: 0 0 16px color-mix(in oklch, var(--color-sage-400) 14%, transparent);
  animation: recIn 0.2s var(--ease-out);
}
@keyframes recIn { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.rec-control--stream {
  border-color: color-mix(in oklch, var(--color-viz-blue, #5b9bd5) 50%, transparent);
  box-shadow: 0 0 16px color-mix(in oklch, var(--color-viz-blue, #5b9bd5) 16%, transparent);
}
.rec-control--busy {
  border-color: color-mix(in oklch, var(--color-amber-400) 45%, transparent);
  box-shadow: 0 0 16px color-mix(in oklch, var(--color-amber-400) 12%, transparent);
}

.rec-cancel, .rec-stop {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0; cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
}
.rec-cancel { background: transparent; border: 1px solid var(--color-border); color: var(--color-text-muted); }
.rec-cancel:hover { color: var(--color-danger); border-color: color-mix(in oklch, var(--color-danger) 50%, transparent); }
.rec-stop { background: var(--color-sage-400); border: none; color: oklch(0.16 0.01 95); animation: pulse 2s infinite; }
.rec-control--stream .rec-stop { background: var(--color-viz-blue, #5b9bd5); color: #08131e; }
.rec-stop:hover { filter: brightness(1.08); }
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--color-sage-400) 34%, transparent); }
  50% { box-shadow: 0 0 0 6px transparent; }
}

.rec-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--color-danger); box-shadow: 0 0 8px var(--color-danger);
  animation: blink 1.4s infinite;
}
.rec-control--stream .rec-dot { background: var(--color-viz-blue, #5b9bd5); box-shadow: 0 0 8px var(--color-viz-blue, #5b9bd5); }
.rec-control--busy .rec-dot { background: var(--color-amber-400); box-shadow: 0 0 8px var(--color-amber-400); animation: none; }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

.rec-status {
  font-size: 0.72rem; letter-spacing: 0.04em; flex-shrink: 0;
  color: var(--color-sage-300); font-family: var(--font-sans);
}
.rec-control--stream .rec-status { color: var(--color-viz-blue, #5b9bd5); }
.rec-control--busy .rec-status { color: var(--color-amber-300); }

.rec-timer {
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.76rem;
  color: var(--color-text-umber); flex-shrink: 0; font-variant-numeric: tabular-nums;
}

.wave { display: flex; align-items: center; gap: 2px; height: 24px; width: 68px; overflow: hidden; }
.wave i {
  flex: 1; min-width: 2px; max-width: 4px; border-radius: 2px;
  background: var(--color-sage-400); height: 8%; opacity: 0.9;
  transition: height 0.09s linear;
}
.rec-control--stream .wave i { background: var(--color-viz-blue, #5b9bd5); }

.shimmer {
  width: 68px; height: 7px; border-radius: 4px;
  background: linear-gradient(90deg, transparent,
    color-mix(in oklch, var(--color-amber-400) 38%, transparent), transparent);
  background-size: 200% 100%;
  animation: sh 1.1s linear infinite;
}
@keyframes sh { from { background-position: 200% 0; } to { background-position: -200% 0; } }

@media (prefers-reduced-motion: reduce) {
  .rec-dot, .rec-stop, .shimmer, .wave i { animation: none !important; transition: none !important; }
}
</style>
