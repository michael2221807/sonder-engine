import { cloneDeep, get } from 'lodash-es';
import type { PipelineContext } from '../pipeline/types';
import { compileStateUpdates, type StateUpdateBaseline, type StateUpdateContract } from './compiler';
import { compiledCommandGuard } from './command-guard';

export interface StateUpdatePolicy { contract: StateUpdateContract; prompt: string; settlementTemplate?: string;
  source?: 'inline' | 'settlement'; guard?: () => void }
interface Session { baseline: StateUpdateBaseline; contract: StateUpdateContract; protocol: string; settlementTemplate?: string;
  source: 'inline' | 'settlement'; compiled: boolean; generationId: string | undefined; guard?: () => void }

/** Host-owned synchronization. No board, cards, model calls or persistent writes. */
export class RoundStateUpdates {
  private readonly sessions = new WeakMap<object, Session>();
  constructor(private readonly policyForRound: (ctx: PipelineContext) => StateUpdatePolicy | undefined) {}

  prepare(ctx: PipelineContext): PipelineContext {
    const policy = ctx.meta.isEnhancedOpening ? undefined : this.policyForRound(ctx);
    if (!policy) return ctx;
    if (!policy.prompt.trim()) throw new Error('State update protocol is missing');
    if (ctx.meta.stateUpdateSession) throw new Error('State updates already prepared');
    const source = policy.source === 'settlement' ? 'settlement' : 'inline';
    if (source === 'settlement' && (ctx.meta.splitGen !== true || !policy.settlementTemplate?.trim()))
      throw new Error('Dedicated settlement requires split generation and a pack template');
    policy.guard?.();
    const snapshot = ctx.stateSnapshot, contract = cloneDeep(policy.contract);
    const items = cloneDeep(get(snapshot, contract.inventoryPath));
    const token = {};
    compileStateUpdates({ version: 1, actions: [] }, { round: ctx.roundNumber, items: {}, balances: {} }, contract);
    this.sessions.set(token, { contract, guard: policy.guard, protocol: policy.prompt,
      settlementTemplate: policy.settlementTemplate, source, compiled: false, generationId: ctx.generationId, baseline: {
      round: ctx.roundNumber,
      items: items && typeof items === 'object' && !Array.isArray(items) ? Object.fromEntries(Object.entries(items)) : {},
      balances: Object.fromEntries(Object.entries(contract.accounts).map(([name, account]) => [name, cloneDeep(get(snapshot, account.path))])),
    } });
    ctx.meta.stateUpdateSession = token;
    ctx.meta.stateUpdatesRequired = true;
    ctx.meta.stateUpdateSource = source;
    if (source === 'settlement') return ctx;
    const message = { role: 'system' as const, content: policy.prompt };
    if (ctx.meta.splitStep2Messages) {
      const base = ctx.meta.splitStep2Messages;
      ctx.meta.splitStep2Messages = [message, ...base];
      ctx.meta.splitStep2Sources = ['state-update-protocol', ...(ctx.meta.splitStep2Sources ?? base.map(() => 'unknown'))];
      return ctx;
    }
    let at = 0;
    for (let i = ctx.messages.length - 1; i >= 0; i--) if (ctx.messages[i].role === 'user') { at = i; break; }
    const sources = ctx.messageSources ?? ctx.messages.map(() => 'unknown');
    return { ...ctx, messages: [...ctx.messages.slice(0, at), message, ...ctx.messages.slice(at)],
      messageSources: [...sources.slice(0, at), 'state-update-protocol', ...sources.slice(at)] };
  }

  settlementInput(ctx: PipelineContext): { protocol: string; template: string; baseline: StateUpdateBaseline } | undefined {
    const session = this.session(ctx);
    if (!session || session.source !== 'settlement') return;
    if (!session.settlementTemplate) throw new Error('Settlement template is missing');
    return { protocol: session.protocol, template: session.settlementTemplate, baseline: cloneDeep(session.baseline) };
  }

  private session(ctx: PipelineContext): Session | undefined {
    ctx.meta.roundOwnership?.guard();
    const token = ctx.meta.stateUpdateSession;
    const session = token ? this.sessions.get(token) : undefined;
    if (ctx.meta.stateUpdatesRequired && !session) throw new Error('State update session is missing');
    if (session && (session.generationId !== ctx.generationId || session.baseline.round !== ctx.roundNumber))
      throw new Error('State update session belongs to another round');
    session?.guard?.();
    return session;
  }

  beforeCommands(ctx: PipelineContext): PipelineContext {
    const session = this.session(ctx);
    if (!session) return ctx;
    if (session.compiled) throw new Error('本回合状态更新已处理，不能重复执行');
    if (ctx.parsedResponse?.parseOk === false) throw new Error('本回合状态更新格式有误，未获得可保存的结果。');
    const raw = session.source === 'settlement' ? ctx.meta.stateSettlementUpdates : ctx.parsedResponse?.customFields?.state_updates;
    if (raw === undefined) throw new Error('本回合缺少状态更新结果，已停止保存；不会按没有变化处理');
    const result = compileStateUpdates(raw, session.baseline, session.contract);
    session.compiled = true;
    const paths = [session.contract.inventoryPath, ...Object.values(session.contract.accounts).map(c => c.path)];
    const notices = result.notices.map(n => ({ success: false,
      command: { action: 'set' as const, key: `state_updates.actions.${n.index}` }, error: n.reason }));
    const directGuard = compiledCommandGuard(paths, []);
    const directRejected: NonNullable<PipelineContext['rejectedCommands']> = [];
    const step2Commands = (ctx.parsedResponse?.commands ?? []).filter(command => {
      if (session.source !== 'settlement') return true;
      const error = directGuard(command);
      if (!error) return true;
      directRejected.push({ success: false, command, error });
      return false;
    });
    return { ...ctx, parsedResponse: { ...ctx.parsedResponse!, commands: [...step2Commands, ...result.commands] },
      rejectedCommands: [...(ctx.rejectedCommands ?? []), ...notices, ...directRejected],
      meta: { ...ctx.meta, stateUpdateCommandGuard: compiledCommandGuard(paths, result.commands) } };
  }

  beforeSave(ctx: PipelineContext): void {
    const session = this.session(ctx);
    if (session && ctx.parsedResponse?.parseOk === false) throw new Error('本回合状态更新格式有误，未获得可保存的结果。');
    if (session && !session.compiled) throw new Error('本回合状态更新尚未处理，已停止保存');
  }
}
