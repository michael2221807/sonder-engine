import type { VectorPacket } from '../../../engine/plot-vector/core/types';
export interface NarrativeAxis { id: string; meaning: string; negative?: string; positive: string }

/**
 * The round's narrative impulse as the model reads it (rebuild plan phase 4): only the data — each
 * dimension's meaning and tendency, its value, the strength. How to use it (a light nudge, never a verdict)
 * is said once, in the pack's plot-vector mode text, which every such request carries.
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
  const prompt = strength === 0 ? '' : `本回合剧情动能（引擎按上一轮结算得出，用法见「本回合使用剧情动能」；数值范围[-1,1]，力度${strength}，加权值只表示轻推程度）。维度说明与数值：
${JSON.stringify(values)}`;
  return { version: 'narrative-input-v0.3', settlementId: packet.settlementId, dimensionSchemaVersion: packet.dimensionSchemaVersion, readoutVersion: packet.readoutVersion, strength, values, prompt };
}
