import { AI_SETTINGS_STORAGE_KEY } from '../ai/ai-service';

/** 从 localStorage 读取 AI 生成设置（每回合调用，确保设置变更立即生效） */
export function readAISettings(): { streaming: boolean; splitGen: boolean; contextCompiler: boolean } {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_STORAGE_KEY);
    if (!raw) return { streaming: true, splitGen: false, contextCompiler: true };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      streaming: parsed.streaming !== false,
      splitGen: parsed.splitGen === true,
      // Context Compiler v1 (2026-09-04): default ON (PO decision Q2); absent key = on.
      contextCompiler: parsed.contextCompiler !== false,
    };
  } catch {
    return { streaming: true, splitGen: false, contextCompiler: true };
  }
}

/** UUID v4 — 兼容 HTTP 本地开发环境（crypto.randomUUID 需要 secure context） */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Polyfill: crypto.getRandomValues 在 http://localhost 也可用
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (typeof crypto !== 'undefined' && crypto.getRandomValues)
      ? (crypto.getRandomValues(new Uint8Array(1))[0] & 0xf)
      : Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
