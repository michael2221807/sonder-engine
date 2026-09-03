import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TtsService } from '@/engine/tts/tts-service';
import { TtsProviderRegistry } from '@/engine/tts/provider-registry';
import { DEFAULT_TTS_SETTINGS } from '@/engine/tts/types';
import type { TtsProvider, TtsSettings } from '@/engine/tts/types';
import type { TtsAudioPlayer } from '@/engine/tts/audio-player';
import { eventBus } from '@/engine/core/event-bus';

// ─── fakes ───

type FakeProvider = TtsProvider & { synthCalls: string[]; streamUrlCalls: string[] };

function makeFakeProvider(overrides?: Partial<TtsProvider>): FakeProvider {
  const synthCalls: string[] = [];
  const streamUrlCalls: string[] = [];
  const provider = {
    backend: 'cosyvoice' as const,
    synthCalls,
    streamUrlCalls,
    async synthesize(text: string): Promise<Blob> {
      synthCalls.push(text);
      // Pad past TtsService.MIN_AUDIO_BYTES (128) so capture/download treat it as
      // real audio; the text prefix is kept for any content assertions.
      return new Blob([text, new Uint8Array(256)], { type: 'audio/wav' });
    },
    getStreamUrl(text: string): string | null {
      streamUrlCalls.push(text);
      return `http://localhost:9880/?text=${encodeURIComponent(text)}&streaming=1`;
    },
    async listSpeakers() { return [{ name: 'coolkey', voiceId: 'coolkey' }]; },
    ...overrides,
  };
  return provider as FakeProvider;
}

type FakePlayer = TtsAudioPlayer & {
  played: Array<{ kind: 'blob' | 'url'; value: string }>;
  preloaded: string[];
  liveParams: Array<{ rate: number; volume: number }>;
};

function makeFakePlayer(): FakePlayer {
  const played: Array<{ kind: 'blob' | 'url'; value: string }> = [];
  const preloaded: string[] = [];
  const liveParams: Array<{ rate: number; volume: number }> = [];
  const player: FakePlayer = {
    played,
    preloaded,
    liveParams,
    setLiveParams(rate, volume) { liveParams.push({ rate, volume }); },
    async play(blob, opts) {
      const t = await blob.text();
      if (opts.signal.aborted) throw new DOMException('aborted', 'AbortError');
      played.push({ kind: 'blob', value: t });
    },
    async playUrl(url, opts) {
      if (opts.signal.aborted) throw new DOMException('aborted', 'AbortError');
      played.push({ kind: 'url', value: url });
    },
    preload(url) { preloaded.push(url); },
    // Fake duration: constant 1.0s per clip (decoupled from blob byte size, which is
    // now padded). Prewarm math: N seconds → ceil(N) clips buffered before playback.
    async measureDurationSec() { return 1.0; },
    stop() {},
    pause() {},
    resume() {},
  };
  return player;
}

function makeService(
  provider: TtsProvider,
  settings: Partial<TtsSettings>,
  opts?: { player?: TtsAudioPlayer; noConfig?: boolean },
) {
  const registry = new TtsProviderRegistry();
  registry.register('cosyvoice', () => provider);
  const aiService = {
    getTtsConfigForBackend: () => (opts?.noConfig
      ? undefined
      : {
          id: 'tts1', name: 'cosy', apiCategory: 'tts', provider: 'custom',
          url: 'http://localhost:9880', apiKey: '', model: '',
          temperature: 0, maxTokens: 0, enabled: true,
        }),
  } as unknown as { getTtsConfigForBackend: (b: string) => unknown };
  const merged: TtsSettings = { ...DEFAULT_TTS_SETTINGS, enabled: true, ...settings };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new TtsService(aiService as any, registry, { player: opts?.player ?? makeFakePlayer(), settings: merged });
}

let toasts: unknown[];
let offToast: () => void;
beforeEach(() => {
  toasts = [];
  offToast = eventBus.on('ui:toast', (p) => { toasts.push(p); });
});
afterEach(() => {
  offToast();
  vi.restoreAllMocks();
});

describe('TtsService guards', () => {
  it('does nothing when disabled', async () => {
    const provider = makeFakeProvider();
    const svc = makeService(provider, { enabled: false });
    await svc.speak('你好世界。', 'r1');
    expect(provider.synthCalls).toEqual([]);
    expect(provider.streamUrlCalls).toEqual([]);
  });

  it('emits a warning toast when no TTS config is available', async () => {
    const provider = makeFakeProvider();
    const svc = makeService(provider, { enabled: true }, { noConfig: true });
    await svc.speak('你好世界。', 'r1');
    expect(provider.streamUrlCalls).toEqual([]);
    expect(toasts.some((t) => (t as { i18nKey?: string }).i18nKey === 'engine.toast.ttsNoConfig')).toBe(true);
  });

  it('does nothing for empty/marker-only text', async () => {
    const provider = makeFakeProvider();
    const svc = makeService(provider, {});
    await svc.speak('   \n  ', 'r1');
    expect(provider.streamUrlCalls).toEqual([]);
    expect(provider.synthCalls).toEqual([]);
  });
});

describe('TtsService stream mode (分句流式, default)', () => {
  // segmentMaxSentences:1 forces one segment per sentence so we can exercise the
  // multi-segment pipeline mechanics deterministically (default grouping would
  // merge these short test sentences into a single segment — see the merge test).
  it('streams each segment via playUrl, never synthesize', async () => {
    const provider = makeFakeProvider();
    const player = makeFakePlayer();
    const svc = makeService(provider, { transmissionMode: 'stream', segmentMaxSentences: 1, defaultSpeaker: 'coolkey' }, { player });
    await svc.speak('第一句话内容。第二句话内容。', 'r1');
    // Two segments → one getStreamUrl + one playUrl each.
    expect(provider.streamUrlCalls.length).toBe(2);
    expect(provider.synthCalls).toEqual([]);
    expect(player.played.length).toBe(2);
    expect(player.played.every((p) => p.kind === 'url')).toBe(true);
    expect(player.played[0].value).toContain('streaming=1');
  });

  it('groups short sentences into fewer segments by default (segmentTargetChars)', async () => {
    const provider = makeFakeProvider();
    const player = makeFakePlayer();
    // Default 120 chars / 6 sentences → three short sentences collapse to ONE segment.
    const svc = makeService(provider, { transmissionMode: 'stream' }, { player });
    await svc.speak('第一句。第二句。第三句。', 'r1');
    expect(player.played.length).toBe(1);
    expect(provider.streamUrlCalls.length).toBe(1);
  });

  it('preloads the NEXT segment while the current one plays', async () => {
    const provider = makeFakeProvider();
    const player = makeFakePlayer();
    const svc = makeService(provider, { transmissionMode: 'stream', segmentMaxSentences: 1 }, { player });
    await svc.speak('第一句内容啊。第二句内容啊。第三句内容啊。', 'r1');
    // 3 segments → segments 2 and 3 get prefetched (last has no successor).
    expect(player.preloaded.length).toBe(2);
    expect(player.played.length).toBe(3);
  });

  it('strips markers before building the stream URL', async () => {
    const provider = makeFakeProvider();
    const svc = makeService(provider, { transmissionMode: 'stream' });
    await svc.speak('【环境】天黑了。`他在想`。', 'r1');
    expect(provider.streamUrlCalls[0]).not.toContain('【');
    expect(provider.streamUrlCalls[0]).not.toContain('`');
  });

  it('never sends 判定 blocks to the provider (any transmission mode)', async () => {
    const raw = '他一跃而上。〖行动:成功,判定值:45,难度:35,基础:30,幸运:+8,环境:+5,状态:+2〗屋檐碎裂。';

    const streaming = makeFakeProvider();
    await makeService(streaming, { transmissionMode: 'stream' }).speak(raw, 'r1');
    expect(streaming.streamUrlCalls.join('')).not.toContain('判定值');
    expect(streaming.streamUrlCalls.join('')).toContain('屋檐碎裂');

    const pseudo = makeFakeProvider();
    await makeService(pseudo, { transmissionMode: 'pseudo' }).speak(raw, 'r2');
    expect(pseudo.synthCalls.join('')).not.toContain('判定值');

    const full = makeFakeProvider();
    await makeService(full, { transmissionMode: 'full' }).speak(raw, 'r3');
    expect(full.synthCalls.join('')).not.toContain('判定值');
    expect(full.synthCalls.join('')).toContain('他一跃而上');
  });

  it('falls back to full (synthesize) when getStreamUrl returns null', async () => {
    const provider = makeFakeProvider({ getStreamUrl: () => null });
    const player = makeFakePlayer();
    const svc = makeService(provider, { transmissionMode: 'stream' }, { player });
    await svc.speak('一段正文内容。', 'r1');
    expect(provider.synthCalls.length).toBe(1);
    expect(player.played[0].kind).toBe('blob');
  });

  it('falls back to full for a SINGLE sentence when its stream fetch fails (non-abort)', async () => {
    const provider = makeFakeProvider();
    const player = makeFakePlayer();
    player.playUrl = async () => { throw new Error('[TTS] stream fetch failed 500'); };
    const svc = makeService(provider, { transmissionMode: 'stream' }, { player });
    await svc.speak('一段正文内容。', 'r1');
    expect(provider.streamUrlCalls.length).toBe(1); // stream attempted
    expect(provider.synthCalls.length).toBe(1);     // then that sentence fell back to full
    expect(player.played.length).toBe(1);
    expect(player.played[0].kind).toBe('blob');
    expect(svc.getState().status).toBe('idle');
  });

  it('per-segment fallback: a failed segment synthesizes, siblings keep streaming', async () => {
    const provider = makeFakeProvider();
    const player = makeFakePlayer();
    let calls = 0;
    // Fail only the FIRST segment's stream; later segments stream fine.
    player.playUrl = async (url, opts) => {
      calls += 1;
      if (calls === 1) throw new Error('[TTS] stream fetch failed 500');
      if (opts.signal.aborted) throw new DOMException('aborted', 'AbortError');
      player.played.push({ kind: 'url', value: url });
    };
    // Force one segment per sentence so we have two independent segments.
    const svc = makeService(provider, { transmissionMode: 'stream', segmentMaxSentences: 1 }, { player });
    await svc.speak('第一句内容啊。第二句内容啊。', 'r1');
    expect(provider.synthCalls.length).toBe(1);          // segment 1 fell back
    const blobPlays = player.played.filter((p) => p.kind === 'blob');
    const urlPlays = player.played.filter((p) => p.kind === 'url');
    expect(blobPlays.length).toBe(1);                    // segment 1 played as blob
    expect(urlPlays.length).toBe(1);                     // segment 2 still streamed
  });

  it('ends in idle state after completing', async () => {
    const provider = makeFakeProvider();
    const svc = makeService(provider, { transmissionMode: 'stream' });
    await svc.speak('一段足够长的正文内容用于测试。', 'r1');
    expect(svc.getState().status).toBe('idle');
    expect(svc.getState().roundKey).toBeNull();
  });
});

describe('TtsService full mode', () => {
  it('synthesizes the whole text once and plays a blob', async () => {
    const provider = makeFakeProvider();
    const player = makeFakePlayer();
    const svc = makeService(provider, { transmissionMode: 'full' }, { player });
    await svc.speak('第一句话。第二句话。第三句话。', 'r1');
    expect(provider.synthCalls.length).toBe(1);
    expect(provider.streamUrlCalls).toEqual([]);
    expect(player.played.length).toBe(1);
    expect(player.played[0].kind).toBe('blob');
  });
});

describe('TtsService live rate/volume', () => {
  it('setSettings pushes rate/volume to the live player immediately (real-time)', () => {
    const provider = makeFakeProvider();
    const player = makeFakePlayer();
    const svc = makeService(provider, {}, { player });
    svc.setSettings({ ...DEFAULT_TTS_SETTINGS, enabled: true, rate: 1.5, volume: 0.3 });
    expect(player.liveParams.at(-1)).toEqual({ rate: 1.5, volume: 0.3 });
  });
});

describe('TtsService pseudo mode (假流式)', () => {
  it('segments client-side, synthesizes each whole (no streaming URL), plays blobs', async () => {
    const provider = makeFakeProvider();
    const player = makeFakePlayer();
    // prewarm 0 + one segment per sentence → 2 segments, each synthesized whole.
    const svc = makeService(provider, { transmissionMode: 'pseudo', prewarmSeconds: 0, segmentMaxSentences: 1 }, { player });
    await svc.speak('第一句话内容。第二句话内容。', 'r1');
    expect(provider.streamUrlCalls).toEqual([]);           // never uses streaming=1
    expect(provider.synthCalls.length).toBe(2);            // each segment synthesized whole
    expect(player.played.length).toBe(2);
    expect(player.played.every((p) => p.kind === 'blob')).toBe(true);
    expect(svc.getState().status).toBe('idle');
  });

  it('prewarm buffers enough seconds BEFORE the first playback', async () => {
    const provider = makeFakeProvider();
    const player = makeFakePlayer();
    // Each sentence is 11 chars → 1.1s fake audio. prewarm 2.5s → needs 3 segments
    // synthesized before the first play. Force one segment per sentence.
    const timeline: string[] = [];
    const origSynth = provider.synthesize.bind(provider);
    provider.synthesize = async (txt, o) => { timeline.push('syn'); return origSynth(txt, o); };
    const origPlay = player.play.bind(player);
    player.play = async (b, o) => { timeline.push('play'); return origPlay(b, o); };

    const svc = makeService(provider, { transmissionMode: 'pseudo', prewarmSeconds: 2.5, segmentMaxSentences: 1 }, { player });
    await svc.speak('一二三四五六七八九十。一二三四五六七八九十。一二三四五六七八九十。一二三四五六七八九十。', 'r1');
    // First 'play' must be preceded by ≥3 'syn' (3 × 1.1s = 3.3s ≥ 2.5s prewarm).
    const firstPlay = timeline.indexOf('play');
    const synBeforeFirstPlay = timeline.slice(0, firstPlay).filter((e) => e === 'syn').length;
    expect(synBeforeFirstPlay).toBeGreaterThanOrEqual(3);
  });

  it('prewarm=0 plays as soon as the first segment is ready (synth ahead while playing)', async () => {
    const provider = makeFakeProvider();
    const player = makeFakePlayer();
    const timeline: string[] = [];
    const origSynth = provider.synthesize.bind(provider);
    provider.synthesize = async (txt, o) => { timeline.push('syn'); return origSynth(txt, o); };
    const origPlay = player.play.bind(player);
    player.play = async (b, o) => { timeline.push('play'); return origPlay(b, o); };

    const svc = makeService(provider, { transmissionMode: 'pseudo', prewarmSeconds: 0, segmentMaxSentences: 1 }, { player });
    await svc.speak('第一段啊。第二段啊。第三段啊。', 'r1');
    // prewarm=0 → playback starts without buffering everything. First play is
    // preceded by at most the current segment + the one-ahead synth (< all 3).
    const firstPlay = timeline.indexOf('play');
    const synBeforeFirstPlay = timeline.slice(0, firstPlay).filter((e) => e === 'syn').length;
    expect(synBeforeFirstPlay).toBeLessThan(3);
    expect(player.played.length).toBe(3);
  });

  it('skips a segment whose synthesis fails; siblings still play', async () => {
    const provider = makeFakeProvider();
    const player = makeFakePlayer();
    let n = 0;
    provider.synthesize = async (txt: string) => {
      n += 1;
      if (n === 1) throw new Error('[CosyVoice] synthesize failed 500');
      return new Blob([txt], { type: 'audio/wav' });
    };
    const svc = makeService(provider, { transmissionMode: 'pseudo', prewarmSeconds: 0, segmentMaxSentences: 1 }, { player });
    await svc.speak('第一段啊。第二段啊。', 'r1');
    // segment 1 failed → skipped; segment 2 played.
    expect(player.played.length).toBe(1);
    expect(player.played[0].kind).toBe('blob');
    expect(svc.getState().status).toBe('idle');
  });

  it('emits ttsFailed toast when every segment fails to synthesize', async () => {
    const provider = makeFakeProvider();
    provider.synthesize = async () => { throw new Error('[CosyVoice] synthesize failed 500'); };
    const svc = makeService(provider, { transmissionMode: 'pseudo', prewarmSeconds: 0, segmentMaxSentences: 1 });
    await svc.speak('第一段啊。第二段啊。', 'r1');
    expect(toasts.some((t) => (t as { i18nKey?: string }).i18nKey === 'engine.toast.ttsFailed')).toBe(true);
  });
});

describe('TtsService round-audio cache (下载)', () => {
  it('pseudo mode captures blobs → hasRoundAudio + downloadable', async () => {
    const provider = makeFakeProvider();
    const svc = makeService(provider, { transmissionMode: 'pseudo', prewarmSeconds: 0, segmentMaxSentences: 1 });
    await svc.speak('第一段啊。第二段啊。', 'round-7');
    expect(svc.hasRoundAudio()).toBe(true);
    expect(svc.getCacheState()).toEqual({ available: true, roundKey: 'round-7' });
    const dl = await svc.buildRoundAudioDownload();
    expect(dl).not.toBeNull();
    expect(dl?.filename).toContain('round-7');
  });

  it('full mode caches the single whole-round blob', async () => {
    const provider = makeFakeProvider();
    const svc = makeService(provider, { transmissionMode: 'full' });
    await svc.speak('整段正文内容。', 'round-9');
    expect(svc.hasRoundAudio()).toBe(true);
    expect(svc.getCacheState().roundKey).toBe('round-9');
  });

  it('stream mode keeps no byte blobs but stays downloadable via on-demand re-synth', async () => {
    const provider = makeFakeProvider();
    const svc = makeService(provider, { transmissionMode: 'stream' });
    await svc.speak('第一段啊。第二段啊。', 'round-3');
    // No captured byte-blobs in stream mode, but text is stored → download available
    // (built by re-synthesizing the whole round on demand).
    expect(svc.hasRoundAudio()).toBe(true);
    expect(svc.getCacheState().roundKey).toBe('round-3');
    const dl = await svc.buildRoundAudioDownload();
    expect(dl).not.toBeNull();
    expect(dl?.filename).toContain('round-3');
  });

  it('download re-synthesizes on demand when captured blobs are empty/corrupt', async () => {
    // synth returns a tiny (header-only) blob → capture skips it; download must
    // fall back to on-demand full-text synth. Here the fake always returns text-bytes,
    // which for the whole-round text is > MIN → a valid download.
    const provider = makeFakeProvider();
    const svc = makeService(provider, { transmissionMode: 'full' });
    await svc.speak('一段足够长的正文内容用来下载测试。', 'round-5');
    const dl = await svc.buildRoundAudioDownload();
    expect(dl).not.toBeNull();
  });

  it('clearRoundAudio() drops the cache and broadcasts tts:cache', async () => {
    const provider = makeFakeProvider();
    const svc = makeService(provider, { transmissionMode: 'full' });
    await svc.speak('整段正文内容。', 'round-9');
    expect(svc.hasRoundAudio()).toBe(true);
    const cacheEvents: unknown[] = [];
    const off = eventBus.on('tts:cache', (p) => { cacheEvents.push(p); });
    svc.clearRoundAudio();
    off();
    expect(svc.hasRoundAudio()).toBe(false);
    expect(cacheEvents.some((e) => (e as { available?: boolean }).available === false)).toBe(true);
  });

  it('a new round speak evicts the previous round cache', async () => {
    const provider = makeFakeProvider();
    const svc = makeService(provider, { transmissionMode: 'full' });
    await svc.speak('第一回合正文。', 'round-1');
    expect(svc.getCacheState().roundKey).toBe('round-1');
    await svc.speak('第二回合正文。', 'round-2');
    expect(svc.getCacheState().roundKey).toBe('round-2');
  });
});

describe('TtsService abort / re-entrancy', () => {
  it('stop() mid-flight resets to idle with no unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (e: { reason?: unknown }) => { rejections.push('reason' in e ? e.reason : e); };
    process.on('unhandledRejection', onUnhandled);

    // player.playUrl that never resolves until aborted
    const player = makeFakePlayer();
    player.playUrl = (_url, opts) => new Promise<void>((_res, rej) => {
      opts.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const provider = makeFakeProvider();
    const svc = makeService(provider, { transmissionMode: 'stream' }, { player });
    const p = svc.speak('第一句话内容。', 'r1');
    await Promise.resolve();
    svc.stop();
    await p;
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', onUnhandled);

    expect(svc.getState().status).toBe('idle');
    expect(rejections).toEqual([]);
  });

  it('a second speak() supersedes the first without leaving stale state', async () => {
    const provider = makeFakeProvider();
    const svc = makeService(provider, { transmissionMode: 'full' });
    const p1 = svc.speak('第一次朗读的正文内容。', 'r1');
    const p2 = svc.speak('第二次朗读的正文内容。', 'r2');
    await Promise.allSettled([p1, p2]);
    expect(svc.getState().status).toBe('idle');
  });
});

describe('TtsService listSpeakers', () => {
  it('delegates to the provider', async () => {
    const provider = makeFakeProvider();
    const svc = makeService(provider, {});
    expect(await svc.listSpeakers()).toEqual([{ name: 'coolkey', voiceId: 'coolkey' }]);
  });
});
