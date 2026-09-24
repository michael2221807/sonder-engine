import type { VectorPacket } from '../../../engine/plot-vector/core/types';
export interface NarrativeAxis { id: string; meaning: string; negative?: string; positive: string }

/**
 * Candidate wording v0.2 (D130 §3.4). NOT the default: `narrative-input.ts` (v0.1) stays wired
 * to the lab UI; this file is only consumed by the research follow-up executor so the two
 * wordings can be compared on identical inputs. Numbers (values, weighted, strength) are
 * computed exactly as in v0.1 — only the words around them change.
 *
 * Principle kept from the review: nudge only within what established facts and the player's
 * own action allow; separate "known impossible" from "not yet happened"; allow replies, small
 * discoveries and new leeway that already have a motive; never read the block as a duty to
 * add an event, task, operation or promise; never act for the player.
 */
export const LAB_NARRATIVE_AXES_V2: readonly NarrativeAxis[] = [
  { id: 'S', meaning: '事情推进的顺逆倾向', negative: '已在进行的事更容易遇到一点小阻力，仍留着绕行或稍后再试的余地', positive: '已在进行的事更容易顺着走' },
  { id: 'Y', meaning: '建立联系和沟通的容易程度', positive: '已经存在的交流、已经有动机的人更容易给出自然的回应' },
  { id: 'J', meaning: '出现可利用选择的倾向', positive: '情境里本来就有的余地更容易被看见' },
];

export function buildNarrativeInputV2(packet: VectorPacket, axes: readonly NarrativeAxis[] = LAB_NARRATIVE_AXES_V2, strength = 0.25) {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Narrative strength must be in [0,1]');
  const values = axes.map((axis) => {
    const value = packet.dimensions[axis.id];
    if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error(`Missing or unnormalized axis ${axis.id}`);
    return { id: axis.id, meaning: axis.meaning, value, weighted: Math.round(value * strength * 10000) / 10000,
      tendency: value === 0 ? '无额外倾向' : value < 0 ? (axis.negative ?? '该倾向较弱，不等于相反事件必须发生') : axis.positive };
  });
  const prompt = strength === 0 ? '' : `以下是引擎按上一轮结算得出的剧情倾向，供本回合参考。它不是指令，不是成功概率，不是必须兑现的数值，也不是玩家要承受的惩罚。
先看玩家这回合做了什么、没做什么，以及已经确定的事实；再看哪些维度和此刻情境有关。只在已有动机和既定事实允许的范围内轻推：可以让已经在进行的交流更容易得到自然的回应，让已经在推进的事顺一点或遇到一点小阻力，让情境里本来就有的余地更容易被看见。明确不可能的事仍然不可能；还没发生的事不必因为数值而发生。不要为了体现某个维度去新增事件、任务、操作或承诺；不要替玩家做玩家没说的动作；可以只用一部分，也可以完全不用，不用不需要交代。不向玩家解释这些数值。本版不结转、不积债、不要求将来补偿。
数值范围[-1,1]；力度${strength}；加权值只表达轻推程度。维度说明与数值：
${JSON.stringify(values)}`;
  return { version: 'narrative-input-v0.2-candidate', settlementId: packet.settlementId, dimensionSchemaVersion: packet.dimensionSchemaVersion, readoutVersion: packet.readoutVersion, strength, values, prompt };
}
