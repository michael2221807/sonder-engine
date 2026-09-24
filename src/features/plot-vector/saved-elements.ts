import { DEFAULT_ENGINE_PATHS as P } from '@/engine/pipeline/types';
import { capabilityKey, type SavedElement, type BoundCard } from './genesis/post-save';

export interface ProjectionIssue { path: string; reason: string }
const bookkeeping = new Set(['数量', '剩余', '剩余次数', '持续', '持续回合', '剩余回合', 'count', 'quantity', 'remaining']);
const names = ['状态名称', '名称', 'name'];
const descriptions = ['状态描述', '描述', 'description'];
export function readPath(state: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined, state);
}

/** v2 uses inventory record keys, never display names. Arrays without IDs retain an
 * explicit unique-name fallback; ambiguous names are reported, never silently merged. */
export function projectSavedElements(state: unknown, options: { includeEnvironment?: boolean } = {}): { entries: SavedElement[]; issues: ProjectionIssue[] } {
  const entries: SavedElement[] = [], issues: ProjectionIssue[] = [];
  const sources: Array<readonly [string, SavedElement['kind']]> = [[P.inventoryItems, 'item'], [P.talents, 'talent'], [P.statusEffects, 'effect']];
  if (options.includeEnvironment) sources.push([P.environmentTags, 'environment']);
  for (const [path, kind] of sources) {
    const collection = readPath(state, path);
    if (collection == null) continue;
    if (typeof collection !== 'object') { issues.push({ path, reason: '条目集合格式不正确' }); continue; }
    const array = Array.isArray(collection);
    const pending: SavedElement[] = [];
    for (const [key, value] of Object.entries(collection)) {
      const raw = typeof value === 'string' && kind === 'talent' ? { 名称: value } : value;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { issues.push({ path: `${path}.${key}`, reason: '条目必须有名称与内容' }); continue; }
      const data = raw as Record<string, unknown>;
      const name = names.map(k => data[k]).find(v => typeof v === 'string' && v.trim()) ?? (!array ? key : undefined);
      if (!name) { issues.push({ path: `${path}.${key}`, reason: '条目缺少名称' }); continue; }
      const explicitId = data.id ?? data.ID;
      const identity = !array ? key : typeof explicitId === 'string' && explicitId ? explicitId : `name:${name}`;
      const description = descriptions.map(k => data[k]).find(v => typeof v === 'string') ?? '';
      const rest = Object.fromEntries(Object.entries(data).filter(([k]) => !bookkeeping.has(k) && !names.includes(k) && !descriptions.includes(k) && k !== 'id' && k !== 'ID'));
      pending.push({ id: `${kind}:${identity}`, kind, capability: { ...rest, name, description } });
    }
    const counts = new Map<string, number>();
    for (const e of pending) counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
    for (const e of pending) {
      if (counts.get(e.id)! > 1) { issues.push({ path, reason: `重复身份 ${e.id}，需要稳定 ID，未合并成卡` }); continue; }
      entries.push(e);
    }
  }
  return { entries, issues };
}

/** Pending replacements and removed entries cannot keep an old ability active. */
export function activeSavedCards(entries: readonly SavedElement[], rows: readonly { bound?: BoundCard }[]): BoundCard[] {
  const current = new Map(entries.map(e => [e.id, capabilityKey(e)]));
  const seen = new Set<string>();
  return rows.flatMap(row => {
    const card = row.bound;
    if (!card || current.get(card.task.entry.id) !== capabilityKey(card.task.entry) || seen.has(card.task.entry.id)) return [];
    seen.add(card.task.entry.id);
    return [card];
  });
}
