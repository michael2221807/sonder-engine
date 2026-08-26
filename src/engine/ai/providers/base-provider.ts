/**
 * AI Provider 抽象基类
 *
 * 每个具体 Provider 实现不同 API 的请求格式：
 * - OpenAIProvider: OpenAI/DeepSeek/自定义兼容 API
 * - ClaudeProvider: Anthropic Claude Messages API
 * - GeminiProvider: Google Gemini GenerateContent API
 *
 * 对应 STEP-03B M2.4。
 */
import type { APIConfig, GenerateOptions } from '../types';

export abstract class BaseProvider {
  constructor(protected config: APIConfig) {}

  /**
   * 发送生成请求并返回完整文本
   *
   * 子类实现需处理：
   * 1. 消息格式转换（AIMessage[] → Provider 特定格式）
   * 2. 流式/非流式请求
   * 3. 响应解析
   * 4. AbortSignal 传递（取消和超时）
   */
  abstract generate(options: GenerateOptions): Promise<string>;

  // ─── 共享工具方法 ───

  /** 清理 URL 末尾的 /v1 和 / — 统一 base URL 格式 */
  protected normalizeUrl(url: string): string {
    return url.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  }

  /**
   * 估算消息的 token 数量（粗略）
   * CJK 字符约 1 token/字，西文约 4 字符/token
   * 用于在请求前检查是否可能超出上下文窗口
   */
  protected estimateTokens(messages: Array<{ content: string }>): number {
    const overheadPerMessage = 8;
    return messages.reduce((sum, msg) => {
      let cjkCount = 0;
      for (const ch of msg.content) {
        const code = ch.charCodeAt(0);
        if (code >= 0x4e00 && code <= 0x9fff) cjkCount++;
      }
      const nonCjkCount = Math.max(0, msg.content.length - cjkCount);
      return sum + overheadPerMessage + cjkCount + Math.ceil(nonCjkCount / 4);
    }, 0);
  }

  /**
   * 获取已知模型的近似上下文窗口大小
   * 同时检查 provider 类型和模型名（应对自定义模型名的情况）
   * 返回 null 表示未知模型，不做 maxTokens 裁剪
   */
  protected getContextWindow(model: string): number | null {
    const m = model.toLowerCase();
    const provider = this.config.provider;

    // 优先按 provider 类型匹配（覆盖自定义/微调模型名的情况）
    if (provider === 'claude' || m.includes('claude')) return 200_000;
    if (provider === 'gemini' || m.includes('gemini')) return 1_000_000;

    if (m.includes('deepseek') || provider === 'deepseek') return 64_000;
    // 火山方舟 doubao 系（epic P4）：seed-1.6 官方 256k；带显式窗口后缀的按后缀，
    // 其余保守取 128k（低估只会多裁剪 maxTokens，不会导致超窗报错）。
    if (m.includes('doubao')) {
      if (m.includes('256k')) return 256_000;
      if (m.includes('128k')) return 128_000;
      if (m.includes('32k')) return 32_000;
      if (m.includes('seed-1-6') || m.includes('seed-1.6')) return 256_000;
      return 128_000;
    }
    if (m.includes('moonshot') || m.includes('kimi')) return 128_000;
    if (m.includes('gpt-4o') || m.includes('gpt-4.1') || m.includes('o1') || m.includes('o3')) return 128_000;
    if (m.includes('gpt-4')) return 128_000;
    if (m.includes('gpt-3.5')) return 16_385;

    return null;
  }

  /**
   * 自动裁剪 maxTokens 避免超出上下文窗口
   *
   * 逻辑移植自 demo aiService.ts clampMaxTokensForContext:
   * 1. 估算输入 token 数
   * 2. 若 (输入 + maxTokens + safety) > 上下文窗口，自动下调 maxTokens
   * 3. 未知模型不做裁剪
   */
  protected clampMaxTokens(
    messages: Array<{ content: string }>,
    requestedMaxTokens: number,
  ): number {
    const contextWindow = this.getContextWindow(this.config.model);
    if (!contextWindow) return requestedMaxTokens;

    const inputTokens = this.estimateTokens(messages);
    const safety = 512;
    const available = contextWindow - inputTokens - safety;

    if (available < 256) {
      throw new Error(
        `上下文长度不足：估算输入≈${inputTokens} tokens，模型上下文≈${contextWindow}。请减少 prompt 或使用更大上下文的模型。`,
      );
    }

    const clamped = Math.min(requestedMaxTokens, Math.max(256, available));
    if (clamped < requestedMaxTokens) {
      console.warn(
        `[Provider] maxTokens 自动下调: ${requestedMaxTokens} → ${clamped}` +
        `（输入≈${inputTokens}，上下文≈${contextWindow}）`,
      );
    }
    return clamped;
  }

  /**
   * 通用 SSE 流处理器
   *
   * 移植自 demo processSSEStream，含 <thinking> 标签过滤逻辑：
   * - 部分模型（DeepSeek R1 等）在流式输出中先输出 reasoning_content
   * - 被包裹在 <thinking>...</thinking> 中，需要过滤掉
   * - 容错：若模型省略 </thinking> 但开始输出 ```json，自动结束过滤
   */
  protected async processSSEStream(
    response: Response,
    extractContent: (data: string) => string,
    onStreamChunk?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('无法获取响应流');

    const decoder = new TextDecoder();
    let rawFullText = '';
    let buffer = '';
    let inThinkingTag = false;
    let thinkingBuffer = '';

    try {
      while (true) {
        if (signal?.aborted) {
          try { await reader.cancel(); } catch { /* 忽略 cancel 错误 */ }
          throw new Error('请求已取消');
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          let data = trimmed.slice(5);
          if (data.startsWith(' ')) data = data.slice(1);
          if (data === '[DONE]') continue;

          try {
            const content = extractContent(data);
            if (!content) continue;

            rawFullText += content;

            // thinking 标签过滤 — 逐字符处理
            for (const char of content) {
              thinkingBuffer += char;

              if (thinkingBuffer.includes('<thinking>')) {
                inThinkingTag = true;
                thinkingBuffer = '';
                continue;
              }

              if (inThinkingTag && thinkingBuffer.includes('</thinking>')) {
                inThinkingTag = false;
                thinkingBuffer = '';
                continue;
              }

              // 容错：thinking 块中遇到 ``` 开头 → 自动结束过滤
              if (inThinkingTag) {
                const fenceIdx = thinkingBuffer.indexOf('```');
                if (fenceIdx !== -1) {
                  const carry = thinkingBuffer.slice(fenceIdx);
                  inThinkingTag = false;
                  thinkingBuffer = '';
                  onStreamChunk?.(carry);
                  continue;
                }
              }

              if (!inThinkingTag) {
                const possibleTag = '<thinking>'.startsWith(thinkingBuffer) ||
                                    '</thinking>'.startsWith(thinkingBuffer);
                if (!possibleTag && thinkingBuffer.length > 0) {
                  onStreamChunk?.(thinkingBuffer);
                  thinkingBuffer = '';
                } else if (thinkingBuffer.length > 11) {
                  // 超过最长标签长度仍未匹配 → 输出并清空
                  onStreamChunk?.(thinkingBuffer);
                  thinkingBuffer = '';
                }
              }
            }
          } catch {
            // 单个 SSE data 解析失败不影响后续
          }
        }
      }

      // 流结束后输出剩余的 buffer
      if (!inThinkingTag && thinkingBuffer.length > 0) {
        onStreamChunk?.(thinkingBuffer);
      }
    } finally {
      reader.releaseLock();
    }

    return rawFullText;
  }

  /**
   * 检测错误是否为"流式不支持"
   * 用于流式请求失败时自动降级为非流式
   */
  protected isStreamUnsupportedError(message: string): boolean {
    const m = message.toLowerCase();
    return (
      (m.includes('stream') && (m.includes('not supported') || m.includes('unsupported') || m.includes('invalid') || m.includes('unknown'))) ||
      m.includes('text/event-stream') ||
      m.includes('sse')
    );
  }
}
