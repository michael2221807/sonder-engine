import { AIService, applyPersistedAISettings } from '../engine/ai/ai-service';
import { eventBus } from '../engine/core/event-bus';
import { useAPIManagementStore } from '../engine/stores/engine-api';
import { watch } from 'vue';

/** Moved verbatim out of main.ts bootstrap() (R5 step 5). Statement order inside is behavior. */
export function createAiStack() {
  const apiStore = useAPIManagementStore();
  apiStore.loadFromStorage();

  const aiService = new AIService();
  aiService.setConfigs([...apiStore.apiConfigs]);
  aiService.setAssignments([...apiStore.apiAssignments]);

  // ── CR-7 fix: 从 localStorage 恢复 AI 生成设置到 aiService ──
  // APIPanel 在 B.1.4 中将 maxRetries 持久化到 'aga_ai_settings'，
  // 但仅在用户主动保存时同步到 aiService。此处在启动时补做一次同步。
  // 共享 helper —— 与 ManagementView 全量导入后的恢复逻辑共用，避免分叉。
  applyPersistedAISettings(aiService);

  // ── Low-load mode: SettingsPanel emits event → sync to aiService ──
  eventBus.on<{ enabled: boolean; maxRequests: number }>('ai:rate-limiter-config', (payload) => {
    if (!payload) return;
    aiService.configureRateLimiter({
      enabled: payload.enabled,
      maxRequests: payload.maxRequests,
      windowMs: 60_000,
    });
  });

  // ── #9: 响应式同步 API 配置变更到 AIService ──
  // 用户在 APIPanel 修改配置后，store 更新，watch 立即同步到 AIService 实例，
  // 无需刷新页面。必须在 pinia 激活后 (app.use(pinia) 之后) 调用 watch。
  watch(() => apiStore.apiConfigs, (configs) => {
    aiService.setConfigs([...configs]);
  }, { deep: true });
  watch(() => apiStore.apiAssignments, (assignments) => {
    aiService.setAssignments([...assignments]);
  }, { deep: true });

  return { aiService };
}
