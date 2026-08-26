// App doc: docs/user-guide/pages/game-main.md §3.13 (配音 · CosyVoice)
/**
 * TtsService — 配音编排核心。
 *
 * 职责:
 *   - 从 AIService 取 tts 类 APIConfig(getTtsConfigForBackend),经 registry
 *     解析出 CosyVoiceProvider。
 *   - speak():按 transmissionMode 走「分句流式」或「整段非流式」。
 *       · stream(默认): splitSentences 细分句 → groupSentencesBySize 按「目标字数+
 *         最多句数」智能拼段(平衡断点+短尾合并)→ 逐段 provider.getStreamUrl()
 *         (CosyVoice streaming=1)→ 服务端 chunked ogg,`<audio crossOrigin>` 原生
 *         边下边播;当前段播放时 preload 下一段 → 首段快出声、段间近无缝。每段独立
 *         回落:某段流式失败 → 该段改整段 synthesize,不牵连后续段(可靠可控)。
 *       · pseudo(假流式): 同样分段,但每段普通非流式 synthesize 整段 blob;自建缓冲
 *         (预热攒够 prewarmSeconds 秒再开播,边播边生成下一段)。不用 streaming=1,
 *         对不支持/CORS 不便传输级流式的部署更稳。
 *       · full:        provider.synthesize() 整段 WAV → 一次播放,最稳。
 *     stream 若不受支持(getStreamUrl 首段返回 null)整体回落 full。
 *   - 播放态经 eventBus 'tts:state' 广播给 UI(播放键/状态栏 chip)。
 *   - 失败逐级回落,永远有声音或明确 toast;不抛给调用方(fire-and-forget 安全)。
 *
 * 镜像 ImageService,但音频瞬时播放不落盘(设计文档 §5)。
 * 引擎铁律:不 import vue-i18n;toast 走 i18nKey + message 兜底。
 */
import { eventBus } from '../core/event-bus';
import type { AIService } from '../ai/ai-service';
import type { TtsProviderRegistry } from './provider-registry';
import type { TtsProvider, TtsSettings, TtsStatus, TtsStateEvent, TtsCacheEvent, TtsBackendType, TtsSpeaker } from './types';
import { DEFAULT_TTS_SETTINGS } from './types';
import { loadTtsSettings } from './tts-settings';
import { stripMarkersForSpeech, splitSentences, groupSentencesBySize } from './sentence-splitter';
import { HtmlAudioPlayer, type TtsAudioPlayer } from './audio-player';
import { concatWavBlobs } from './audio-concat';

export class TtsService {
  private settings: TtsSettings;
  private player: TtsAudioPlayer;

  // 播放态
  private status: TtsStatus = 'idle';
  private currentRoundKey: string | null = null;
  private playAbort: AbortController | null = null;

  // 当前(最新)回合的全配音缓存 — 供下载。
  //  - blobs: 假流式/整段播放时逐段捕获的整段 WAV(真流式无字节 → 空)。
  //  - text/speaker/instruct: 该回合朗读参数,供"缓存缺失/损坏"或真流式模式下**即时
  //    重合成整段**兜底(保证下载永远拿到一个干净可播 WAV)。
  // 只留最新一回合;新回合 speak 开始或编排器 clearRoundAudio 时清。
  private roundAudio:
    | { roundKey: string; blobs: Blob[]; mime: string; text: string; speaker: string; instruct?: string }
    | null = null;
  /** 缓存 blob 的最小合法字节数(≤ 此值视为空/仅 WAV 头,不入缓存/不用于下载)。 */
  private static readonly MIN_AUDIO_BYTES = 128;

  constructor(
    private aiService: Pick<AIService, 'getTtsConfigForBackend'>,
    private registry: TtsProviderRegistry,
    opts?: { player?: TtsAudioPlayer; settings?: TtsSettings },
  ) {
    this.settings = opts?.settings ?? loadTtsSettings();
    this.player = opts?.player ?? new HtmlAudioPlayer();
  }

  // ─── settings ───

  getSettings(): TtsSettings {
    return this.settings;
  }

  setSettings(next: TtsSettings): void {
    this.settings = next;
    // 音量/语速实时生效:立即把新值推给正在播放的音频元素(否则要等下一段才变)。
    this.player.setLiveParams?.(next.rate, next.volume);
    // Re-broadcast current state so UI subscribers (play-button visibility,
    // quick-switch chip) refresh their derived readiness when settings change.
    eventBus.emit('tts:state', this.getState());
  }

  /**
   * Re-read settings from localStorage. Call on cold-start (done in ctor) and
   * after a full-backup import restores aga_tts_settings, so the live service
   * (and orchestrator auto-narrate) don't run on a stale in-memory copy.
   * Mirrors applyPersistedAISettings for AI settings.
   */
  reloadSettings(): void {
    this.settings = loadTtsSettings();
    // Broadcast so all live UI copies (settings section, quick-switch chip,
    // play-button readiness) re-sync after a backup import re-wrote localStorage.
    eventBus.emit('tts:state', this.getState());
  }

  /**
   * 当前配音服务商 — 用户在设置区 / 配音快切选定(epic P2 / D2),
   * settings.backend 已由 normalizeTtsSettings 校验为合法 union 值。
   */
  private activeBackend(): TtsBackendType {
    return this.settings.backend;
  }

  /** 是否具备可用配置(总开关开 + 当前服务商有 tts 类 API)。UI 用于禁用播放键。 */
  isReady(): boolean {
    return this.settings.enabled && !!this.aiService.getTtsConfigForBackend(this.activeBackend());
  }

  // ─── provider ───

  private resolveProvider(): TtsProvider | null {
    const backend = this.activeBackend();
    const config = this.aiService.getTtsConfigForBackend(backend);
    if (!config) return null;
    try {
      return this.registry.resolve({
        backend,
        endpoint: config.url,
        apiKey: config.apiKey,
        model: config.model,
        routingPath: config.useCustomRouting ? config.customRoutingPath : undefined,
        credentials: config.credentials,
      });
    } catch {
      return null;
    }
  }

  /** 拉取服务端音色列表(设置区/ popover 用)。无配置或失败返回 []。 */
  async listSpeakers(): Promise<TtsSpeaker[]> {
    const provider = this.resolveProvider();
    if (!provider) return [];
    return provider.listSpeakers();
  }

  // ─── 播放态广播 ───

  private emitState(status: TtsStatus): void {
    this.status = status;
    eventBus.emit('tts:state', this.getState());
  }

  getState(): TtsStateEvent {
    return {
      status: this.status,
      roundKey: this.status === 'idle' ? null : this.currentRoundKey,
    };
  }

  // ─── 回合全配音缓存(下载) ───

  /** 最新回合是否可下载配音。有捕获字节 OR 有可即时重合成的文本即可(全模式)。 */
  hasRoundAudio(): boolean {
    return !!this.roundAudio && (this.roundAudio.blobs.length > 0 || !!this.roundAudio.text);
  }

  getCacheState(): TtsCacheEvent {
    return { available: this.hasRoundAudio(), roundKey: this.roundAudio?.roundKey ?? null };
  }

  private emitCache(): void {
    eventBus.emit('tts:cache', this.getCacheState());
  }

  /**
   * 开一个回合的全配音缓存槽:记下朗读参数(text/speaker/instruct),使下载在**任意
   * 模式**(含真流式)都能兜底即时重合成。blobs 由 captureBlob 在播放时追加(假流式/整段)。
   */
  private beginRoundAudio(roundKey: string, text: string, speaker: string, instruct?: string): void {
    this.roundAudio = { roundKey, blobs: [], mime: 'audio/wav', text, speaker, instruct };
    this.emitCache();
  }

  /** 播放中把每段音频 blob 收进当前回合缓存(仅当前 speak 仍持有 abort;跳过空/仅头的 blob)。 */
  private captureBlob(blob: Blob, abort: AbortController): void {
    if (this.playAbort !== abort) return;           // 已被新 speak 取代 → 不写旧缓存
    if (blob.size < TtsService.MIN_AUDIO_BYTES) return; // 空/仅 WAV 头 → 不缓存(避免几字节损坏文件)
    if (!this.roundAudio || this.roundAudio.roundKey !== (this.currentRoundKey ?? '')) return;
    this.roundAudio.blobs.push(blob);
    this.emitCache();
  }

  /** 清空回合全配音缓存(编排器"下回合生成完毕"时调用,或新回合 speak 开始)。 */
  clearRoundAudio(): void {
    if (this.roundAudio) {
      this.roundAudio = null;
      this.emitCache();
    }
  }

  /**
   * 构造当前回合全配音的可下载文件(一个干净可播 WAV)。无缓存返回 null。
   * 策略:优先合并播放时捕获的整段 blob(假流式/整段,秒出);若无字节(真流式)或
   * 合并结果异常小(损坏),**即时用存下的整段文本重合成一个整段 WAV**兜底,保证永远可播。
   */
  async buildRoundAudioDownload(): Promise<{ blob: Blob; filename: string } | null> {
    const ra = this.roundAudio;
    if (!ra) return null;

    let blob: Blob | null = null;
    if (ra.blobs.length > 0) {
      try {
        blob = await concatWavBlobs(ra.blobs);
      } catch {
        blob = ra.blobs.find((b) => b.size >= TtsService.MIN_AUDIO_BYTES) ?? null;
      }
    }
    // 缓存缺失 / 结果小到只有 WAV 头(无音频)→ 即时重合成整段文本。
    if ((!blob || blob.size < TtsService.MIN_AUDIO_BYTES) && ra.text) {
      const provider = this.resolveProvider();
      if (provider) {
        try {
          blob = await provider.synthesize(ra.text, { speaker: ra.speaker, instruct: ra.instruct });
        } catch {
          blob = null;
        }
      }
    }
    if (!blob || blob.size < TtsService.MIN_AUDIO_BYTES) return null;

    const safe = ra.roundKey.replace(/[^\w.-]+/g, '_') || 'round';
    return { blob, filename: `配音-${safe}.wav` };
  }

  // ─── 控制 ───

  /** 打断当前朗读并复位到 idle。 */
  stop(): void {
    this.playAbort?.abort();
    this.playAbort = null;
    this.player.stop();
    this.currentRoundKey = null;
    this.emitState('idle');
  }

  pause(): void {
    if (this.status === 'playing') {
      this.player.pause();
      this.emitState('paused');
    }
  }

  resume(): void {
    if (this.status === 'paused') {
      this.player.resume();
      this.emitState('playing');
    }
  }

  /**
   * 朗读一段文本。fire-and-forget 安全:内部吞掉错误(转 toast),不 reject。
   * @param roundKey — UI 用于标识「哪个回合在播」(如 `round-12` 或消息 idx)。
   */
  async speak(rawText: string, roundKey: string): Promise<void> {
    if (!this.settings.enabled) return;

    const provider = this.resolveProvider();
    if (!provider) {
      eventBus.emit('ui:toast', {
        type: 'warning',
        i18nKey: 'engine.toast.ttsNoConfig',
        message: '未配置可用的配音(TTS)API',
        id: 'tts-no-config',
      });
      return;
    }

    const text = stripMarkersForSpeech(rawText);
    if (!text) return;

    // 新一次朗读打断上一次;并清掉上一回合的全配音缓存(将由本次重新捕获)。
    this.stop();
    this.clearRoundAudio();
    const abort = new AbortController();
    this.playAbort = abort;
    this.currentRoundKey = roundKey;

    const speaker = this.settings.defaultSpeaker;
    const instruct = this.settings.defaultInstruct || undefined;

    // 开缓存槽:记下本回合朗读参数,使下载在任意模式(含真流式)都能兜底重合成。
    this.beginRoundAudio(roundKey, text, speaker, instruct);

    try {
      const mode = this.settings.transmissionMode;
      if (mode === 'full') {
        await this.playFull(provider, text, speaker, instruct, abort);
      } else if (mode === 'pseudo') {
        await this.playPseudoStream(provider, text, speaker, instruct, abort);
      } else {
        await this.playSentenceStream(provider, text, speaker, instruct, abort);
      }
    } catch (err) {
      if (!isAbort(err)) {
        eventBus.emit('ui:toast', {
          type: 'error',
          i18nKey: 'engine.toast.ttsFailed',
          message: '配音生成失败',
          id: 'tts-failed',
        });
      }
    } finally {
      // Only reset if THIS call still owns the abort controller. If stop()/a new
      // speak() ran during the await, it reassigned this.playAbort (and already
      // emitted idle/playing), so we must not clobber the newer call's state.
      if (this.playAbort === abort) {
        this.playAbort = null;
        this.currentRoundKey = null;
        this.emitState('idle');
      }
    }
  }

  /**
   * 分句流式:切句 → 逐句 streaming=1 播放,当前句播放时 preload 下一句(近无缝)。
   * 每句独立回落:该句流式失败 → 改整段 synthesize,不牵连后续句。
   * 首句 getStreamUrl 返回 null(provider 不支持流式)→ 整体回落整段 full。
   */
  private async playSentenceStream(
    provider: TtsProvider,
    text: string,
    speaker: string,
    instruct: string | undefined,
    abort: AbortController,
  ): Promise<void> {
    // 先细分句(tokenizer),再按「目标字数 + 最多句数」智能拼段(平衡断点+短尾合并)。
    const segments = groupSentencesBySize(
      splitSentences(text),
      this.settings.segmentTargetChars,
      this.settings.segmentMaxSentences,
    );
    if (segments.length === 0) return;

    // 一次性算出每句的流式 URL(纯函数,便于测试断言调用次数 == 句数)。
    const urls = segments.map((seg) => provider.getStreamUrl(seg, { speaker, instruct }));
    if (urls[0] === null) {
      // provider 不支持传输级流式 → 整体回落整段合成,避免逐句都失败。
      await this.playFull(provider, text, speaker, instruct, abort);
      return;
    }

    this.emitState('playing');
    for (let i = 0; i < segments.length; i++) {
      if (abort.signal.aborted) return;
      // 预取下一句:当前句播放期间浏览器已在后台缓冲下一句 → 句间近无缝。
      const nextUrl = urls[i + 1];
      if (nextUrl) this.player.preload?.(nextUrl);
      await this.playSegment(provider, segments[i], urls[i], speaker, instruct, abort);
    }
  }

  /** 播放单句:优先流式 URL;非取消失败 → 该句回落整段 synthesize。 */
  private async playSegment(
    provider: TtsProvider,
    seg: string,
    streamUrl: string | null,
    speaker: string,
    instruct: string | undefined,
    abort: AbortController,
  ): Promise<void> {
    const playOpts = { rate: this.settings.rate, volume: this.settings.volume, signal: abort.signal };
    if (streamUrl) {
      try {
        await this.player.playUrl(streamUrl, playOpts);
        return;
      } catch (streamErr) {
        if (isAbort(streamErr)) throw streamErr; // 真取消 → 上抛,不回落
        // 该句流式失败(CORS/5xx/编码)→ 落该句整段 synthesize。
      }
    }
    if (abort.signal.aborted) return;
    const blob = await provider.synthesize(seg, { speaker, instruct, signal: abort.signal });
    if (abort.signal.aborted) return;
    await this.player.play(blob, playOpts);
  }

  /** 整段非流式:一次 synthesize 整段 → 一次播放。最稳,无句间处理。 */
  private async playFull(
    provider: TtsProvider,
    text: string,
    speaker: string,
    instruct: string | undefined,
    abort: AbortController,
  ): Promise<void> {
    this.emitState('synthesizing');
    const blob = await provider.synthesize(text, { speaker, instruct, signal: abort.signal });
    if (abort.signal.aborted) return;
    this.captureBlob(blob, abort); // 缓存整段全配音,供下载
    this.emitState('playing');
    await this.player.play(blob, { rate: this.settings.rate, volume: this.settings.volume, signal: abort.signal });
  }

  /**
   * 假流式:客户端分段,但**不用 streaming=1**,每段普通非流式 synthesize 整段 blob;
   * 自建缓冲——预热攒够 prewarmSeconds 秒(或全部合成完)再开播,之后边播当前段边
   * 合成下一段(生产者-消费者)。每段独立跳过(某段合成失败不牵连后续)。
   * 对不支持/CORS 不便传输级流式的部署更稳,靠"提前量"吸收合成抖动。
   */
  private async playPseudoStream(
    provider: TtsProvider,
    text: string,
    speaker: string,
    instruct: string | undefined,
    abort: AbortController,
  ): Promise<void> {
    const segments = groupSentencesBySize(
      splitSentences(text),
      this.settings.segmentTargetChars,
      this.settings.segmentMaxSentences,
    );
    if (segments.length === 0) return;

    const prewarmSec = this.settings.prewarmSeconds;

    // 已合成、待播的整段 blob 缓冲(FIFO,按段序)。
    const clips: Blob[] = [];
    let produced = 0;    // 已"尝试合成"的段数(含失败被跳过的)
    let bufferedSec = 0; // 缓冲里累计的音频时长(仅预热判定用)

    // 生产:合成下一个尚未尝试的段并入缓冲。合成失败(非取消)→ 跳过该段,不入缓冲。
    const produceOne = async (): Promise<void> => {
      if (produced >= segments.length) return;
      const seg = segments[produced++];
      try {
        const blob = await provider.synthesize(seg, { speaker, instruct, signal: abort.signal });
        if (abort.signal.aborted) return;
        clips.push(blob);
        this.captureBlob(blob, abort); // 逐段收进当前回合缓存,供下载
        bufferedSec += await this.measureDuration(blob);
      } catch (err) {
        if (isAbort(err)) throw err; // 真取消 → 上抛
        // 非取消失败 → 跳过该段,继续后续段(可靠可控)。
      }
    };

    // 预热:攒够 prewarmSec 秒(或全部合成完)再开播。
    this.emitState('synthesizing');
    while (produced < segments.length && bufferedSec < prewarmSec && !abort.signal.aborted) {
      await produceOne();
    }
    if (abort.signal.aborted) return;

    // 消费:顺序播放缓冲;同时提前合成下一段(边播边生成)。
    this.emitState('playing');
    let playIdx = 0;
    while (!abort.signal.aborted) {
      // 确保 clips[playIdx] 就绪(前面若有段被跳过,继续生产直到有货或耗尽)。
      while (clips.length <= playIdx && produced < segments.length && !abort.signal.aborted) {
        await produceOne();
      }
      if (clips.length <= playIdx) break; // 全部耗尽
      const blob = clips[playIdx];
      // 边播边生成下一段(并发:合成在播放的 await 期间进行)。
      const ahead = produced < segments.length ? produceOne().catch(() => { /* abort 由循环顶判定 */ }) : null;
      // 每段现取 rate/volume,使播放中改设置从下一段起也生效(当前段由 setLiveParams 实时改)。
      await this.player.play(blob, { rate: this.settings.rate, volume: this.settings.volume, signal: abort.signal });
      if (ahead) await ahead;
      playIdx++;
    }

    // 一段都没播出(全部段合成失败)→ 明确 toast,不静默。
    if (!abort.signal.aborted && playIdx === 0) {
      eventBus.emit('ui:toast', {
        type: 'error',
        i18nKey: 'engine.toast.ttsFailed',
        message: '配音生成失败',
        id: 'tts-failed',
      });
    }
  }

  /** 量一个 blob 的音频秒数(预热缓冲用);player 无此能力或失败时回落 0。 */
  private async measureDuration(blob: Blob): Promise<number> {
    try {
      return (await this.player.measureDurationSec?.(blob)) ?? 0;
    } catch {
      return 0;
    }
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError'
    : err instanceof Error ? /abort|signal/i.test(err.message)
    : false;
}

export { DEFAULT_TTS_SETTINGS };
