import type { SavedElement } from './post-save';
import type { CardSpec } from '../contract/types';

/** Hand-written cards in the contract format (interface examples, not model output). */
export interface SaveExample { entry: SavedElement; card: CardSpec }
const example = (id: string, kind: SavedElement['kind'], name: string, description: string, card: Omit<CardSpec, 'for'>): SaveExample => ({
  entry: { id, kind, capability: { name, description } },
  card: { for: name, ...card },
});
export const POSITIVE_EXAMPLES: SaveExample[] = [
  example('tea', 'item', '随身热茶', '每次经过，推力增加3。', { type: 'item', summary: '每次经过，推力 +3。', onPass: 'return { push: 3 };' }),
  example('patience', 'talent', '耐心观察', '首次经过，多走2格。', { type: 'talent', summary: '第一次经过时多走两步。', onPass: 'return ctx.pass === 1 ? { steps: 2 } : {};' }),
  example('notebook', 'item', '随身日记', '经过时获得1点机会，每过一回合多记一页，每页再加1点。',
    { type: 'item', summary: '每过一回合多记一页，机会越来越多。', onPass: 'return { chance: 1 + ctx.level };', growth: { on: 'round', every: 1, max: 50 } }),
];
