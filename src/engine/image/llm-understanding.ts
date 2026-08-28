// App doc: docs/user-guide/pages/game-image.md §图片提炼
/**
 * 通用 LLM 提炼引擎（图片提炼重建 epic §3.4，D3B）
 *
 * 复用主对话 LLM 配置（`usageType: 'main'`）发送 OpenAI 兼容多模态请求：
 * user 消息携带 [图片块, 任务文本块]。仅 OpenAI 兼容 provider 支持图片块
 * （D7 —— Claude/Gemini 直连 provider 会抛明确错误，此处前置检查给出更
 * 友好的引导）。gproxy→Claude 已实测通过（evidence §一 C1）。
 *
 * D3B「必须标明」：`getGeneralLlmInfo` 暴露主对话配置的 provider/model，
 * 设置区与提炼面板用它显示「使用主对话模型配置（当前：<model>）」。
 */
import type { AIService } from '../ai/ai-service';
import type { AIMessage } from '../ai/types';
import type {
  ImageUnderstandingRequest,
  ImageUnderstandingResult,
} from './reference-types';
import {
  buildUnderstandingPrompt,
  parseUnderstandingResponse,
  looksLikeRefusal,
} from './understanding-prompt';

export interface GeneralLlmInfo {
  /** 主对话配置存在且 provider 为 OpenAI 兼容（可用于图片提炼） */
  available: boolean;
  /** APIConfig.name（用户命名的配置名） */
  configName: string;
  /** provider 类型（openai / claude / gemini / deepseek / custom） */
  provider: string;
  model: string;
  /** available=false 时的原因（i18n 由 UI 层处理，这里给机器可判别的枚举） */
  reason?: 'not_configured' | 'provider_unsupported';
}

/** OpenAI 兼容 = 走 /v1/chat/completions 序列化路径的 provider 类型 */
const OPENAI_COMPATIBLE_PROVIDERS = new Set(['openai', 'deepseek', 'custom']);

/**
 * 解析主对话 LLM 配置的可用性与标示信息（D3B「必须标明」的数据源）。
 */
export function getGeneralLlmInfo(aiService: AIService): GeneralLlmInfo {
  const config = aiService.getConfigForUsage('main');
  if (!config) {
    return { available: false, configName: '', provider: '', model: '', reason: 'not_configured' };
  }
  const supported = OPENAI_COMPATIBLE_PROVIDERS.has(config.provider);
  return {
    available: supported,
    configName: config.name,
    provider: config.provider,
    model: config.model,
    reason: supported ? undefined : 'provider_unsupported',
  };
}

/**
 * 用主对话 LLM 配置提炼一张图。
 * 前置条件：request.image 已解析为 data URL（image-service.resolveReferenceAsset）。
 */
export async function describeImageWithGeneralLlm(
  aiService: AIService,
  request: ImageUnderstandingRequest,
): Promise<ImageUnderstandingResult> {
  const dataUrl = request.image.dataUrl;
  if (!dataUrl) {
    throw new Error('[图片提炼] 通用 LLM 引擎需要 data URL 图片输入');
  }

  const info = getGeneralLlmInfo(aiService);
  if (!info.available) {
    throw new Error(
      info.reason === 'not_configured'
        ? '[图片提炼] 未配置主对话 LLM。请先在 API 管理中配置主对话 API。'
        : `[图片提炼] 主对话配置的 provider（${info.provider}）暂不支持图片输入，请改用 OpenAI 兼容配置或切换到 Civitai 视觉引擎。`,
    );
  }

  const { system, taskText } = buildUnderstandingPrompt(request.task, request.prompt);
  const messages: AIMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'image', dataUrl },
        { type: 'text', text: taskText },
      ],
    },
  ];

  const content = await aiService.generate({
    messages,
    usageType: 'main',
    stream: false,
    temperature: request.temperature ?? 0.2,
    maxTokens: request.maxNewTokens ?? 600,
  });

  if (!content.trim()) {
    throw new Error('[图片提炼] 模型返回空响应');
  }

  const parsed = parseUnderstandingResponse(content, request.task);
  if (parsed.degraded && looksLikeRefusal(content)) {
    throw new Error('[图片提炼] 模型拒绝分析该图片（可能因内容审核）。可尝试切换到 Civitai 视觉引擎。');
  }

  return {
    provider: 'general_llm',
    task: request.task,
    caption: parsed.caption,
    tags: parsed.tags,
    positiveDraft: parsed.positiveDraft,
    raw: content,
    createdAt: Date.now(),
  };
}
