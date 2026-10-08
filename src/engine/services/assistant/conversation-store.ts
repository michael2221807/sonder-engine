/**
 * ConversationStore — assistant 对话的持久化层
 *
 * MVP 实现 `InMemoryConversationStore`（存内存 Map）。
 * 接口形状（`ConversationStore` 在 ./types.ts）已为未来 IDB 实现预留，
 * AssistantService 通过 DI 接口而非具体类，replaceImpl drop-in 即可。
 *
 * FIFO trim 在 `appendMessage(sessionId, msg, maxTurns)` 内执行：
 * - 单位是 **turn**（1 turn = 连续的 user + assistant 对）
 * - 算法：从尾部倒序找第 maxTurns 个 user 消息，保留它和之后的所有消息；之前的消息
 *   （包括其间的 system 消息）一并丢弃，见 appendMessageWithFifoTrim
 *
 * 对应 docs/status/plan-assistant-utility-2026-04-14.md §3.2 + Phase 1。
 */
import type {
  AssistantMessage,
  AssistantSession,
  ConversationStore,
} from './types';

export class InMemoryConversationStore implements ConversationStore {
  private sessions = new Map<string, AssistantSession>();

  async load(sessionId: string): Promise<AssistantSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // 防御：返回浅拷贝（消息数组与每条消息本身是新的，payloadDraft / attachments 仍与存储共享引用），
      // 避免外部对消息列表的 mutation 污染存储
      return cloneSession(existing);
    }
    const fresh: AssistantSession = {
      sessionId,
      createdAt: Date.now(),
      messages: [],
    };
    this.sessions.set(sessionId, fresh);
    return cloneSession(fresh);
  }

  async save(session: AssistantSession): Promise<void> {
    if (!session.sessionId) {
      throw new Error('[ConversationStore] save() requires sessionId');
    }
    this.sessions.set(session.sessionId, cloneSession(session));
  }

  async clear(sessionId: string): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // 保留 session 元数据（createdAt/sessionId），仅清空 messages
      // 这与"删除整个 session"不同 —— 用户的"清空对话"按钮走这条路径
      existing.messages = [];
    }
  }

  async list() {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      messageCount: s.messages.length,
    }));
  }
}

/**
 * 把一条新消息追加到 session 并应用 FIFO trim
 *
 * 这是一个独立函数（不是 store 方法）—— 因为 AssistantService 在 build → AI call →
 * append 三步之间，需要先 load 拿到稳定快照，再统一 save。把 trim 作为纯函数让
 * service 层有完全的控制权（可以一次 append 多条）。
 *
 * @param session 待修改的 session（**会被 mutate**）
 * @param msg 新消息
 * @param maxTurns FIFO 上限 turn 数
 */
export function appendMessageWithFifoTrim(
  session: AssistantSession,
  msg: AssistantMessage,
  maxTurns: number,
): void {
  session.messages.push(msg);
  trimToFifoLimit(session, maxTurns);
}

/**
 * FIFO trim —— 仅保留尾部 maxTurns 个 turn 的 user/assistant 消息
 *
 * "Turn" 定义：从一个 user 消息开始，到下一个 user 消息之前的所有消息（含
 * assistant 回复 + 该回合内插入的 system 消息）算作同一个 turn。
 *
 * 算法：
 * 1. 从尾部倒序找第 maxTurns 个 user 消息的索引 keepFromIndex
 * 2. slice(keepFromIndex) —— 保留它和之后的所有消息
 * 3. 之前的所有消息（包括其间的 system）一并丢弃
 *
 * 边界：
 * - maxTurns ≤ 0 / NaN → 不 trim（防 misconfig 删光数据）
 * - user 消息数 ≤ maxTurns → no-op
 *
 * @param session 待修改的 session（**会被 mutate**）
 * @param maxTurns FIFO 上限
 */
export function trimToFifoLimit(session: AssistantSession, maxTurns: number): void {
  if (!Number.isFinite(maxTurns) || maxTurns <= 0) return;

  const messages = session.messages;
  let userSeen = 0;
  let keepFromIndex = -1;

  // 倒序找第 maxTurns 个 user 消息（即要保留的最早一个 user）
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userSeen++;
      if (userSeen === maxTurns) {
        keepFromIndex = i;
        break;
      }
    }
  }

  if (keepFromIndex < 0) return; // user 消息不足 maxTurns 个 → 不裁
  // 检查是否真有"超出"的 user 需要裁
  let userBefore = 0;
  for (let i = 0; i < keepFromIndex; i++) {
    if (messages[i].role === 'user') userBefore++;
  }
  if (userBefore === 0) return; // 没有更早的 user → 无需裁

  session.messages = messages.slice(keepFromIndex);
}

/** Shallow-clone session: new messages array and message objects; payloadDraft / attachments stay shared with the store */
function cloneSession(session: AssistantSession): AssistantSession {
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    messages: session.messages.map((m) => ({ ...m })),
  };
}
