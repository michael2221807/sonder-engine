import type { GenesisOutputV2, SavedElement } from './post-save';

export interface SaveExample { entry: SavedElement; output: GenesisOutputV2; source: string; behaviorReview?: {programHash:string;issues:string[]} | null }
const example = (id: string, kind: SavedElement['kind'], name: string, description: string,
  onVisit: string, initialPersistentState?: Record<string, number | boolean>, onRoundAccepted: string | null = null): SaveExample => ({
  entry: { id, kind, capability: { name, description } },
  source: 'Codex手写接口示例（不是新模型实验）',
  output: { version: 2, card: { name, description, behaviorSummary: description,
    hooks: { onVisit, onRoundAccepted }, ...(initialPersistentState ? { initialPersistentState } : {}) } },
});
export const POSITIVE_EXAMPLES: SaveExample[] = [
  example('tea', 'item', '随身热茶', '每次经过，推力增加3。', "return {effects:[{kind:'add',channel:'S+',amount:3}]};"),
  example('patience', 'talent', '耐心观察', '首次经过，多走2格。', "return {effects:ctx.runState.used?[]:[{kind:'addVisits',amount:2}],runState:{used:true}};"),
  example('notebook', 'item', '随身日记', '经过时获得1点机会，每确认一轮多记一页，每页再加1点。',
    "return {effects:[{kind:'add',channel:'J',amount:1+ctx.persistentState.pages}]};", { pages: 0 },
    'return {persistentState:{pages:ctx.persistentState.pages+1}};'),
];
