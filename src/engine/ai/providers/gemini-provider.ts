/**
 * Gemini Provider — 处理 Google Gemini GenerateContent API
 *
 * Gemini 消息格式要求：
 * 1. system 消息提取为 systemInstruction（包裹在 parts 中）
 * 2. assistant → role: "model"
 * 3. API key 通过 query string 传递（非 header）
 * 4. 流式端点: streamGenerateContent + alt=sse
 *
 * 移植自 demo aiService.ts callGeminiAPI / streamingRequestGemini。
 *
 * 对应 STEP-03B M2.3。
 */
import { BaseProvider } from './base-provider';
import { contentToText, messagesHaveImageBlocks } from '../content-blocks';
import type { GenerateOptions, AIMessage } from '../types';

export class GeminiProvider extends BaseProvider {
  async generate(options: GenerateOptions): Promise<string> {
    const baseUrl = this.normalizeUrl(this.config.url) || 'https://generativelanguage.googleapis.com';
    const { apiKey, model, temperature, maxTokens } = this.config;
    const streaming = options.stream ?? false;

    // 转换消息格式
    const { systemInstruction, contents } = this.convertMessages(options.messages);

    // 估算 token
    const allForEstimate = [
      ...(systemInstruction ? [{ content: systemInstruction }] : []),
      ...contents.map((c) => ({ content: c.parts.map((p) => p.text).join('\n') })),
    ];
    const safeMaxTokens = this.clampMaxTokens(allForEstimate, maxTokens);

    if (streaming) {
      return this.generateStreaming(baseUrl, apiKey, model, systemInstruction, contents, temperature, safeMaxTokens, options);
    }
    return this.generateNonStreaming(baseUrl, apiKey, model, systemInstruction, contents, temperature, safeMaxTokens, options.signal);
  }

  /** 将 AIMessage[] 转换为 Gemini API 格式 */
  private convertMessages(messages: AIMessage[]): {
    systemInstruction: string;
    contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
  } {
    // 图片块本期仅 OpenAIProvider 支持（图片提炼 epic D7）：Gemini 直连缺乏
    // 真实验证凭据，映射为 inlineData 未经实测，明确报错优于静默丢图。
    if (messagesHaveImageBlocks(messages)) {
      throw new Error('图片输入暂仅支持 OpenAI 兼容 API 配置（当前 provider: gemini）。请在 API 管理中改用 OpenAI 兼容配置后重试。');
    }

    let systemInstruction = '';
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    for (const msg of messages) {
      const text = contentToText(msg.content);
      if (msg.role === 'system') {
        systemInstruction += (systemInstruction ? '\n\n' : '') + text;
      } else {
        contents.push({
          // Gemini 使用 "model" 而非 "assistant"
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text }],
        });
      }
    }

    // 确保至少有一条消息
    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: '请开始。' }] });
    }

    return { systemInstruction, contents };
  }

  /** 非流式请求 */
  private async generateNonStreaming(
    baseUrl: string,
    apiKey: string,
    model: string,
    systemInstruction: string,
    contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
    temperature: number,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await fetch(
      `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: systemInstruction
            ? { parts: [{ text: systemInstruction }] }
            : undefined,
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
          },
        }),
        signal,
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini API 错误 ${res.status}: ${body}`);
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  /** 流式请求（含自动降级） */
  private async generateStreaming(
    baseUrl: string,
    apiKey: string,
    model: string,
    systemInstruction: string,
    contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
    temperature: number,
    maxTokens: number,
    options: GenerateOptions,
  ): Promise<string> {
    try {
      // Gemini 流式使用 alt=sse 参数
      const res = await fetch(
        `${baseUrl}/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`,
        {
          method: 'POST',
          headers: {
            'Accept': 'text/event-stream',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents,
            systemInstruction: systemInstruction
              ? { parts: [{ text: systemInstruction }] }
              : undefined,
            generationConfig: {
              temperature,
              maxOutputTokens: maxTokens,
            },
          }),
          signal: options.signal,
        },
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Gemini API 错误 ${res.status}: ${body}`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        throw new Error(`Stream unsupported (content-type=${contentType || 'unknown'})`);
      }

      return await this.processSSEStream(
        res,
        (data) => {
          const parsed = JSON.parse(data);
          return parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        },
        options.onStreamChunk,
        options.signal,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.isStreamUnsupportedError(msg)) throw err;

      // forceStreaming: streaming-only endpoint — re-throw instead of downgrading.
      // See APIConfig.forceStreaming.
      if (this.config.forceStreaming) throw err;

      console.warn('[GeminiProvider] 流式不支持，降级为非流式');
      return this.generateNonStreaming(baseUrl, apiKey, model, systemInstruction, contents, temperature, maxTokens, options.signal);
    }
  }
}
