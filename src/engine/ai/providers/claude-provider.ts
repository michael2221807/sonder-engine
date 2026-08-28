/**
 * Claude Provider — 处理 Anthropic Claude Messages API
 *
 * Claude 消息格式要求：
 * 1. system 消息单独提取为顶层 system 参数
 * 2. messages 数组只能包含 user/assistant 角色
 * 3. 第一条消息必须是 user
 * 4. 使用 x-api-key 而非 Bearer token
 *
 * 移植自 demo aiService.ts callClaudeAPI / streamingRequestClaude。
 *
 * 对应 STEP-03B M2.3。
 */
import { BaseProvider } from './base-provider';
import { contentToText, messagesHaveImageBlocks } from '../content-blocks';
import type { GenerateOptions, AIMessage } from '../types';

export class ClaudeProvider extends BaseProvider {
  async generate(options: GenerateOptions): Promise<string> {
    const baseUrl = this.normalizeUrl(this.config.url) || 'https://api.anthropic.com';
    const { apiKey, model, temperature, maxTokens } = this.config;
    const streaming = options.stream ?? false;

    // 转换消息格式：提取 system，其余转为 Claude 格式
    const { systemPrompt, claudeMessages } = this.convertMessages(options.messages);

    // 估算 token 时需要包含 system prompt
    const allForEstimate = [
      ...(systemPrompt ? [{ content: systemPrompt }] : []),
      ...claudeMessages.map((m) => ({ content: m.content })),
    ];
    const safeMaxTokens = this.clampMaxTokens(allForEstimate, maxTokens);

    if (streaming) {
      return this.generateStreaming(baseUrl, apiKey, model, systemPrompt, claudeMessages, temperature, safeMaxTokens, options);
    }
    return this.generateNonStreaming(baseUrl, apiKey, model, systemPrompt, claudeMessages, temperature, safeMaxTokens, options.signal);
  }

  /** 将 AIMessage[] 转换为 Claude Messages API 格式 */
  private convertMessages(messages: AIMessage[]): {
    systemPrompt: string;
    claudeMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  } {
    // 图片块本期仅 OpenAIProvider 支持（图片提炼 epic D7）：Claude 直连缺乏
    // 真实验证凭据，映射为原生 image source 未经实测，明确报错优于静默丢图。
    if (messagesHaveImageBlocks(messages)) {
      throw new Error('图片输入暂仅支持 OpenAI 兼容 API 配置（当前 provider: claude）。请在 API 管理中改用 OpenAI 兼容配置后重试。');
    }

    let systemPrompt = '';
    const claudeMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const msg of messages) {
      const text = contentToText(msg.content);
      if (msg.role === 'system') {
        // Claude 的 system 是顶层参数，多条 system 消息合并
        systemPrompt += (systemPrompt ? '\n\n' : '') + text;
      } else {
        claudeMessages.push({
          role: msg.role as 'user' | 'assistant',
          content: text,
        });
      }
    }

    // Claude 要求第一条消息必须是 user 角色
    if (claudeMessages.length === 0 || claudeMessages[0].role !== 'user') {
      claudeMessages.unshift({ role: 'user', content: '请开始。' });
    }

    return { systemPrompt, claudeMessages };
  }

  /** 非流式请求 */
  private async generateNonStreaming(
    baseUrl: string,
    apiKey: string,
    model: string,
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    temperature: number,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt || undefined,
        messages,
        temperature,
      }),
      signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Claude API 错误 ${res.status}: ${body}`);
    }

    const data = await res.json();
    return data.content?.[0]?.text ?? '';
  }

  /** 流式请求（含自动降级） */
  private async generateStreaming(
    baseUrl: string,
    apiKey: string,
    model: string,
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    temperature: number,
    maxTokens: number,
    options: GenerateOptions,
  ): Promise<string> {
    try {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Accept': 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: systemPrompt || undefined,
          messages,
          temperature,
          stream: true,
        }),
        signal: options.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Claude API 错误 ${res.status}: ${body}`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        throw new Error(`Stream unsupported (content-type=${contentType || 'unknown'})`);
      }

      return await this.processSSEStream(
        res,
        (data) => {
          const parsed = JSON.parse(data);
          // Claude 流式响应格式：content_block_delta 事件包含文本增量
          if (parsed.type === 'content_block_delta') {
            return parsed.delta?.text ?? '';
          }
          return '';
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

      console.warn('[ClaudeProvider] 流式不支持，降级为非流式');
      return this.generateNonStreaming(baseUrl, apiKey, model, systemPrompt, messages, temperature, maxTokens, options.signal);
    }
  }
}
