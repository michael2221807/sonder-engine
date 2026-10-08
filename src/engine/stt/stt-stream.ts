// App doc: docs/user-guide/pages/game-main.md §3.14 (语音输入 · STT)
/**
 * 实时流式听写客户端 — FunASR 2pass WebSocket 协议(浏览器侧)。
 *
 * 契约(docs/design/stt-streaming-handoff.md 头部):
 *   ① 连 ws(s)://host:port/v1/audio/stream
 *   ② 发 JSON 握手 { mode:'2pass', wav_format:'pcm', audio_fs:16000, chunk_size, itn, is_speaking:true }
 *   ③ 持续发裸 PCM 帧(16k 单声道 int16 LE)
 *   ④ 停止时发 { is_speaking:false },等末尾 final
 *   服务端回:{mode:'2pass-online', text, is_final:false}(partial,覆盖式刷新)
 *            {mode:'2pass-offline', text, is_final:true}(final,带标点、已清洗)
 *
 * 音频:AudioContext({sampleRate:16000}) 让浏览器把麦克风重采样到 16k;AudioWorklet
 * 把 Float32 → Int16 并攒够 STT_STREAM_FRAME_MS 再发一帧(减少小包)。worklet 同时算
 * RMS 电平 → onLevel 驱动波形。
 *
 * 引擎铁律:无游戏特定内容、不 import vue-i18n。错误以 Error 经 onError/onClose 上抛,
 * 由 UI 侧翻译成 toast。协议纯函数(deriveStreamUrl/buildHandshake/parseStreamMessage)
 * 拆出便于单测。
 */
import { DEFAULT_STT_STREAM_PATH, STT_CHUNK_SIZE, STT_STREAM_FRAME_MS } from './types';
import type { SttStreamCallbacks, SttStreamConfig, SttStreamHandle, SttLatencyProfile } from './types';

/** http(s) base URL → ws(s) 流式 URL。空/非法返回 null。 */
export function deriveStreamUrl(baseUrl: string, path: string = DEFAULT_STT_STREAM_PATH): string | null {
  const raw = (baseUrl ?? '').trim();
  if (!raw) return null;
  const noTrail = raw.replace(/\/+$/, '');
  let wsBase: string;
  if (/^https:\/\//i.test(noTrail)) wsBase = noTrail.replace(/^https:\/\//i, 'wss://');
  else if (/^http:\/\//i.test(noTrail)) wsBase = noTrail.replace(/^http:\/\//i, 'ws://');
  else if (/^wss?:\/\//i.test(noTrail)) wsBase = noTrail; // 已是 ws(s)
  else wsBase = `ws://${noTrail}`; // 裸 host:port
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${wsBase}${p}`;
}

/** 构造握手 JSON payload。hotwords/vad_max_silence_ms 有效时作为同级字段加入(FunASR 契约)。 */
export function buildHandshake(
  latency: SttLatencyProfile = 'balanced',
  itn = true,
  hotwords?: string,
  vadMaxSilenceMs?: number,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    mode: '2pass',
    wav_name: 'aga-mic',
    wav_format: 'pcm',
    audio_fs: 16000,
    chunk_size: STT_CHUNK_SIZE[latency] ?? STT_CHUNK_SIZE.balanced,
    itn,
    is_speaking: true,
  };
  if (hotwords && hotwords.trim()) payload.hotwords = hotwords;
  // >0 才传;缺省/非正 = 后端用默认。后端另有 clamp 200-10000 兜底。
  if (typeof vadMaxSilenceMs === 'number' && Number.isFinite(vadMaxSilenceMs) && vadMaxSilenceMs > 0) {
    payload.vad_max_silence_ms = Math.round(vadMaxSilenceMs);
  }
  return payload;
}

/** 解析服务端一条消息 → 归一化事件;非识别消息返回 null。 */
export function parseStreamMessage(raw: string): { kind: 'partial' | 'final'; text: string } | null {
  let ev: unknown;
  try {
    ev = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== 'object') return null;
  const o = ev as { mode?: unknown; text?: unknown; is_final?: unknown };
  const text = typeof o.text === 'string' ? o.text : '';
  const mode = typeof o.mode === 'string' ? o.mode : '';
  const isFinal = o.is_final === true || mode.endsWith('offline');
  // online=partial;offline / is_final=final。忽略其它(如心跳)。
  if (isFinal) return { kind: 'final', text };
  if (mode.endsWith('online')) return { kind: 'partial', text };
  return null;
}

/** worklet 处理器源码(Int16 转换 + 攒帧 + RMS 电平),经 Blob 加载。 */
function workletSource(targetSamples: number): string {
  return `
class AgaPcmProcessor extends AudioWorkletProcessor {
  constructor(){ super(); this._buf=[]; this._n=0; this._target=${targetSamples}; }
  process(inputs){
    const ch = inputs[0] && inputs[0][0];
    if(ch && ch.length){
      let sum=0;
      const out=new Int16Array(ch.length);
      for(let i=0;i<ch.length;i++){ let s=ch[i]; if(s>1)s=1; else if(s<-1)s=-1; out[i]= s<0 ? s*0x8000 : s*0x7fff; sum+=s*s; }
      this.port.postMessage({level: Math.sqrt(sum/ch.length)});
      this._buf.push(out); this._n+=out.length;
      if(this._n>=this._target){
        const merged=new Int16Array(this._n); let o=0;
        for(const b of this._buf){ merged.set(b,o); o+=b.length; }
        this._buf=[]; this._n=0;
        this.port.postMessage({pcm: merged.buffer},[merged.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('aga-pcm', AgaPcmProcessor);
`;
}

/** 停止后等待末尾 final 的兜底超时(ms)。 */
const FINALIZE_TIMEOUT_MS = 4000;
/** 连接建立超时(含后端首次懒加载 ~15s,留足)。 */
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * 打开一段流式听写会话。立即返回句柄;内部异步取麦克风+连 WS,任何失败经
 * callbacks.onError + onClose(error) 上报。UI 拿句柄调 stop()/cancel()。
 */
export function openSttStream(config: SttStreamConfig, callbacks: SttStreamCallbacks): SttStreamHandle {
  const controller = new SttStreamController(config, callbacks);
  void controller.start();
  return controller;
}

class SttStreamController implements SttStreamHandle {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private silent: GainNode | null = null;
  private ownStream = false;
  private stream: MediaStream | null = null;
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 生命周期:idle→starting→open→stopping→closed。closed 后所有回调静默。 */
  private phase: 'idle' | 'starting' | 'open' | 'stopping' | 'closed' = 'idle';

  constructor(
    private readonly config: SttStreamConfig,
    private readonly cb: SttStreamCallbacks,
  ) {}

  async start(): Promise<void> {
    if (this.phase !== 'idle') return;
    this.phase = 'starting';
    // 1) 麦克风(复用外部流或自取)
    try {
      if (this.config.stream) {
        this.stream = this.config.stream;
        this.ownStream = false;
      } else {
        // mediaDevices is undefined on insecure origins (typings say it always exists): keep the optional chain.
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('NO_MEDIA_DEVICES');
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.ownStream = true;
      }
    } catch (err) {
      return this.fail(normalizeMediaError(err));
    }
    if ((this.phase as string) === 'closed') return this.teardown(); // 期间被 cancel

    // 2) 音频图(16k 上下文 → 浏览器自动重采样;worklet 出 Int16 帧 + 电平)
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new Ctx({ sampleRate: 16000 });
      const targetSamples = Math.round((16000 * STT_STREAM_FRAME_MS) / 1000); // 960
      const blob = new Blob([workletSource(targetSamples)], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await this.audioCtx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if ((this.phase as string) === 'closed') return this.teardown();
      this.source = this.audioCtx.createMediaStreamSource(this.stream!);
      this.node = new AudioWorkletNode(this.audioCtx, 'aga-pcm');
      this.node.port.onmessage = (e: MessageEvent) => this.onWorkletMessage(e.data);
      // node 需接到 destination 才会被 pull;用 0 增益避免回放到扬声器。
      this.silent = this.audioCtx.createGain();
      this.silent.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(this.silent);
      this.silent.connect(this.audioCtx.destination);
    } catch (err) {
      return this.fail(err instanceof Error ? err : new Error('AUDIO_INIT_FAILED'));
    }

    // 3) WebSocket
    try {
      this.ws = new WebSocket(this.config.url);
      this.ws.binaryType = 'arraybuffer';
      this.connectTimer = setTimeout(() => {
        if (this.phase === 'starting') this.fail(new Error('STREAM_CONNECT_TIMEOUT'));
      }, CONNECT_TIMEOUT_MS);
      this.ws.onopen = () => this.onOpen();
      this.ws.onmessage = (e) => this.onMessage(e);
      this.ws.onerror = () => {
        if (this.phase !== 'closed') this.fail(new Error('STREAM_WS_ERROR'));
      };
      this.ws.onclose = () => {
        // 正常收尾(stopping)时的 close 不算错误。
        if (this.phase !== 'closed' && this.phase !== 'stopping') this.fail(new Error('STREAM_WS_CLOSED'));
        else if (this.phase === 'stopping') this.finish();
      };
    } catch (err) {
      return this.fail(err instanceof Error ? err : new Error('STREAM_WS_INIT_FAILED'));
    }
  }

  private onOpen(): void {
    if (this.phase !== 'starting') return;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.phase = 'open';
    try {
      this.ws!.send(JSON.stringify(buildHandshake(
        this.config.latency ?? 'balanced', this.config.itn ?? true, this.config.hotwords, this.config.vadMaxSilenceMs,
      )));
    } catch (err) {
      return this.fail(err instanceof Error ? err : new Error('STREAM_HANDSHAKE_FAILED'));
    }
    this.cb.onOpen?.();
  }

  private onWorkletMessage(data: { pcm?: ArrayBuffer; level?: number }): void {
    if (typeof data?.level === 'number') this.cb.onLevel?.(data.level);
    if (data?.pcm && this.ws && this.ws.readyState === WebSocket.OPEN && this.phase === 'open') {
      try {
        this.ws.send(data.pcm);
      } catch {
        /* 单帧发送失败不致命,下一帧继续 */
      }
    }
  }

  private onMessage(e: MessageEvent): void {
    if (this.phase === 'closed') return;
    if (typeof e.data !== 'string') return;
    const parsed = parseStreamMessage(e.data);
    if (!parsed) return;
    if (parsed.kind === 'partial') {
      this.cb.onPartial?.(parsed.text);
    } else {
      this.cb.onFinal?.(parsed.text);
      // 停止后收到 final → 收尾。
      if (this.phase === 'stopping') this.finish();
    }
  }

  stop(): void {
    if (this.phase !== 'open') {
      // 还没连上就停 → 直接取消。
      if (this.phase === 'starting') this.cancel();
      return;
    }
    this.phase = 'stopping';
    this.stopCapture(); // 不再采集/发送,但保持 ws 开着等 final
    try {
      this.ws?.send(JSON.stringify({ is_speaking: false }));
    } catch {
      /* ignore */
    }
    // 兜底:超时仍无 final 就强制收尾。
    this.finalizeTimer = setTimeout(() => this.finish(), FINALIZE_TIMEOUT_MS);
  }

  cancel(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.teardown();
    this.cb.onClose?.();
  }

  /** 正常收尾(stopping 阶段末尾 final 到达或超时)。 */
  private finish(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.teardown();
    this.cb.onClose?.();
  }

  private fail(error: Error): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.teardown();
    this.cb.onError?.(error);
    this.cb.onClose?.(error);
  }

  /** 停止采集(断音频图 + 释放麦克风),但不动 ws(留给收尾)。 */
  private stopCapture(): void {
    try {
      this.node?.port.close();
    } catch {
      /* ignore */
    }
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      this.silent?.disconnect();
    } catch {
      /* ignore */
    }
    if (this.ownStream) this.stream?.getTracks().forEach((t) => t.stop());
    if (this.audioCtx && this.audioCtx.state !== 'closed') this.audioCtx.close().catch(() => {});
    this.node = null;
    this.source = null;
    this.silent = null;
    this.audioCtx = null;
  }

  /** 全量释放(音频 + ws + 定时器)。 */
  private teardown(): void {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.stopCapture();
    if (this.ws) {
      try {
        // 静默关闭:去掉 handler 防止 onclose 二次触发 fail。
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}

/** getUserMedia 异常 → 语义化 Error(UI 据 message 分支 toast)。 */
function normalizeMediaError(err: unknown): Error {
  if (err instanceof Error) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') return new Error('MIC_PERMISSION_DENIED');
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') return new Error('MIC_NOT_FOUND');
    if (err.message === 'NO_MEDIA_DEVICES') return new Error('MIC_NOT_SUPPORTED');
    return err;
  }
  return new Error('MIC_UNKNOWN_ERROR');
}
