// App doc: docs/user-guide/pages/game-image.md §6.3.1 图片提炼（多模态 image_url 序列化）
/**
 * OpenAI 兼容 Provider — 处理 OpenAI / DeepSeek / 自定义 API
 *
 * 端点格式: {url}/v1/chat/completions
 * 消息格式: 标准 ChatCompletion（role + content）
 *
 * 移植自 demo aiService.ts callOpenAICompatibleAPI / streamingRequestOpenAI。
 * 关键差异：
 * - 使用 fetch 代替 axios（减少依赖；非流式也可用 fetch）
 * - DeepSeek R1 的 reasoning_content 字段兼容已在 BaseProvider 的 SSE 过滤中处理
 *
 * 对应 STEP-03B M2.3。
 */
import { BaseProvider } from './base-provider';
import { resolveLlmChatPath } from '../../providers/llm-paths';
import { isBlockContent } from '../content-blocks';
import type { GenerateOptions, AIMessage } from '../types';

/** OpenAI ChatCompletion 多模态 content part（wire 格式） */
type OpenAIWireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIWireMessage {
  role: AIMessage['role'];
  content: string | OpenAIWireContentPart[];
}

export class OpenAIProvider extends BaseProvider {
  /**
   * Chat path — resolution order (epic P4 / D4): explicit custom routing path
   * → llm catalog preset defaultPath (config.backend, e.g. 'volcano_ark' →
   * /api/v3/chat/completions) → OpenAI default /v1/chat/completions.
   */
  private chatPath(): string {
    return resolveLlmChatPath(
      this.config.backend,
      this.config.useCustomRouting ? this.config.customRoutingPath : undefined,
    );
  }

  /**
   * AIMessage[] → wire 格式。图片块映射为标准 snake_case `image_url`
   * （OpenAI 官方 + gproxy 转 Claude 均以此形状实测通过，见
   * docs/status/image-understanding-api-verification-2026-08-27.md §一 C1）。
   * 纯 string content 原样透传，保持既有请求体逐字节不变。
   */
  private toWireMessages(messages: AIMessage[]): OpenAIWireMessage[] {
    return messages.map((msg) => {
      if (!isBlockContent(msg.content)) return { role: msg.role, content: msg.content };
      return {
        role: msg.role,
        content: msg.content.map((block): OpenAIWireContentPart => (
          block.type === 'image'
            ? { type: 'image_url', image_url: { url: block.dataUrl } }
            : { type: 'text', text: block.text }
        )),
      };
    });
  }

  async generate(options: GenerateOptions): Promise<string> {
    const url = this.normalizeUrl(this.config.url);
    const { apiKey, model, temperature, maxTokens } = this.config;
    const messages = options.messages;
    const streaming = options.stream ?? false;

    const safeMaxTokens = this.clampMaxTokens(messages, maxTokens);

    if (streaming) {
      return this.generateStreaming(url, apiKey, model, messages, temperature, safeMaxTokens, options);
    }
    return this.generateNonStreaming(url, apiKey, model, messages, temperature, safeMaxTokens, options.signal);
  }

  /** 非流式请求 */
  private async generateNonStreaming(
    url: string,
    apiKey: string,
    model: string,
    messages: AIMessage[],
    temperature: number,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await fetch(`${url}${this.chatPath()}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: this.toWireMessages(messages),
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API 错误 ${res.status}: ${body}`);
    }

    const data = await res.json();
    return data.choices[0]?.message?.content ?? '';
  }

  /**
   * 流式请求
   * 失败时检测是否为"流式不支持"错误，如是则自动降级为非流式
   */
  private async generateStreaming(
    url: string,
    apiKey: string,
    model: string,
    messages: AIMessage[],
    temperature: number,
    maxTokens: number,
    options: GenerateOptions,
  ): Promise<string> {
    try {
      const res = await fetch(`${url}${this.chatPath()}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: this.toWireMessages(messages),
          temperature,
          max_tokens: maxTokens,
          stream: true,
        }),
        signal: options.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`API 错误 ${res.status}: ${body}`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        throw new Error(`Stream unsupported (content-type=${contentType || 'unknown'})`);
      }

      return await this.processSSEStream(
        res,
        (data) => {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          // 兼容 DeepSeek R1 的 reasoning_content 字段
          if (delta?.reasoning_content) {
            return `<thinking>${delta.reasoning_content}</thinking>`;
          }
          return delta?.content ?? '';
        },
        options.onStreamChunk,
        options.signal,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.isStreamUnsupportedError(msg)) throw err;

      // forceStreaming: this endpoint is streaming-only — a non-streaming retry would
      // 404/hang. Re-throw instead of silently downgrading. See APIConfig.forceStreaming.
      if (this.config.forceStreaming) throw err;

      console.warn('[OpenAIProvider] 流式不支持，降级为非流式');
      return this.generateNonStreaming(url, apiKey, model, messages, temperature, maxTokens, options.signal);
    }
  }
}
