/**
 * applyStrictMessageFormat — 严格消息格式兼容变换。
 *
 * 背景（2026-07-19）：经 gproxy 转发到 claude-opus-4-8 时，AGA 主回合消息里
 * 夹在对话中间的 system（剧情引导 / CoT 伪装）会被转成 Anthropic 的
 * `mid_conv_system` 块并放错位置 → 400；且该模型要求对话以 user 结尾（不支持
 * assistant prefill）。此变换同时消除这两类结构。
 */
import { describe, it, expect } from 'vitest';
import { applyStrictMessageFormat } from './ai-service';
import type { AIMessage } from './types';

const roles = (msgs: AIMessage[]): string[] => msgs.map((m) => m.role);

describe('applyStrictMessageFormat', () => {
  it('复现真实主回合结构：中途 system 转 user + 末尾 assistant(prefill) 转 user', () => {
    // 对应关掉"禁用 Prefill"后的真实 payload（截图 2）：
    // [system×N, assistant(recap), assistant(input), system(plot), user(开始任务), assistant(masquerade)]
    const input: AIMessage[] = [
      { role: 'system', content: 'world rules 0' },
      { role: 'system', content: 'world rules 1' },
      { role: 'assistant', content: '即时剧情回顾' },
      { role: 'assistant', content: '玩家输入包裹' },
      { role: 'system', content: '## 剧情引导' },
      { role: 'user', content: '开始任务' },
      { role: 'assistant', content: '<think>思考已结束</think>好的' },
    ];

    const out = applyStrictMessageFormat(input);

    expect(roles(out)).toEqual([
      'system', 'system', 'assistant', 'assistant', 'user', 'user', 'user',
    ]);
    // 以 user 结尾
    expect(out[out.length - 1].role).toBe('user');
    // 首个非 system 之后不再有任何 system
    const firstNonSys = out.findIndex((m) => m.role !== 'system');
    expect(out.slice(firstNonSys).some((m) => m.role === 'system')).toBe(false);
  });

  it('内容与相对顺序不变，仅改 role', () => {
    const input: AIMessage[] = [
      { role: 'system', content: 'lead' },
      { role: 'user', content: 'u1' },
      { role: 'system', content: 'mid' },
      { role: 'assistant', content: 'tail' },
    ];
    const out = applyStrictMessageFormat(input);
    expect(out.map((m) => m.content)).toEqual(['lead', 'u1', 'mid', 'tail']);
    expect(roles(out)).toEqual(['system', 'user', 'user', 'user']);
  });

  it('开头连续的 system 全部保留（不被转换）', () => {
    const input: AIMessage[] = [
      { role: 'system', content: 's0' },
      { role: 'system', content: 's1' },
      { role: 'system', content: 's2' },
      { role: 'user', content: 'u' },
    ];
    const out = applyStrictMessageFormat(input);
    expect(roles(out)).toEqual(['system', 'system', 'system', 'user']);
  });

  it('已经合法的对话（system 开头、user 结尾、无中途 system）保持不变', () => {
    const input: AIMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ];
    const out = applyStrictMessageFormat(input);
    expect(roles(out)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(out.map((m) => m.content)).toEqual(['s', 'u1', 'a1', 'u2']);
  });

  it('全部是 system 时原样返回（无非 system 消息可处理）', () => {
    const input: AIMessage[] = [
      { role: 'system', content: 's0' },
      { role: 'system', content: 's1' },
    ];
    const out = applyStrictMessageFormat(input);
    expect(roles(out)).toEqual(['system', 'system']);
  });

  it('多条末尾 assistant 全部转为 user', () => {
    const input: AIMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a1' },
      { role: 'assistant', content: 'a2' },
    ];
    const out = applyStrictMessageFormat(input);
    expect(roles(out)).toEqual(['system', 'user', 'user', 'user']);
  });

  it('不修改入参（返回新数组与新对象）', () => {
    const input: AIMessage[] = [
      { role: 'system', content: 's' },
      { role: 'assistant', content: 'a' },
      { role: 'system', content: 'mid' },
      { role: 'user', content: 'u' },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    applyStrictMessageFormat(input);
    expect(input).toEqual(snapshot); // 原数组 role 未被改动
  });
});
