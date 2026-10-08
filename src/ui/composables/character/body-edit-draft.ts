/**
 * Body-edit draft for CharacterDetailsPanel (R7 step 6).
 *
 * body parts / 子宫 / 敏感点 / 纹身 are edited as a local draft inside the modal and committed
 * together via charEditor.updateBody() on save - mirrors the NPC editor's batch-save pattern
 * (RelationshipPanel), so "delete then cancel" cleanly discards drafts. The draft <-> state
 * mapping is moved here verbatim; the modal state, refs and the save call stay in the panel.
 */

export interface BodyEditPart {
  _id: number;
  部位名称: string;
  敏感度: number;
  开发度: number;
  特征描述: string;
  特殊印记: string;
}
export interface BodyEditRecord { _id: number; 日期: string; 描述: string }
interface BodyEditUterus { 状态: string; 宫口状态: string; 内射记录: BodyEditRecord[] }
export interface BodyEditForm {
  身高: number; 体重: number;
  胸围: number; 腰围: number; 臀围: number;
  胸部描述: string; 私处描述: string; 生殖器描述: string;
  身体部位: BodyEditPart[];
  敏感点: string[];
  纹身与印记: string[];
  子宫: BodyEditUterus;
}

/** The blank form the modal starts from before the first open. */
export function emptyBodyEditForm(): BodyEditForm {
  return {
    身高: 0, 体重: 0,
    胸围: 0, 腰围: 0, 臀围: 0,
    胸部描述: '', 私处描述: '', 生殖器描述: '',
    身体部位: [],
    敏感点: [],
    纹身与印记: [],
    子宫: { 状态: '', 宫口状态: '', 内射记录: [] },
  };
}

/**
 * One draft-id counter per panel instance. The ids are stable keys for draftable list rows (so
 * removing a middle row doesn't reuse DOM by index) and are never saved.
 */
export function createBodyEditDraft() {
  let bodyDraftIdSeq = 0;

  /** State `角色.身体` -> draft form, plus the raw 子宫 captured at open time (see fromBodyDraft). */
  function toBodyDraft(b: Record<string, unknown>): { form: BodyEditForm; uterusRaw: Record<string, unknown> } {
    const sw = (b['三围'] as Record<string, number>) ?? {};
    const rawParts = Array.isArray(b['身体部位']) ? (b['身体部位'] as Array<Record<string, unknown>>) : [];
    const rawUterus = (b['子宫'] as Record<string, unknown>) ?? {};
    const rawRecords = Array.isArray(rawUterus['内射记录']) ? (rawUterus['内射记录'] as Array<Record<string, unknown>>) : [];
    const form: BodyEditForm = {
      身高: (b['身高'] as number) ?? 0,
      体重: (b['体重'] as number) ?? 0,
      胸围: sw['胸围'] ?? 0,
      腰围: sw['腰围'] ?? 0,
      臀围: sw['臀围'] ?? 0,
      胸部描述: (b['胸部描述'] as string) ?? '',
      私处描述: (b['私处描述'] as string) ?? '',
      生殖器描述: (b['生殖器描述'] as string) ?? '',
      身体部位: rawParts.map((p) => ({
        _id: bodyDraftIdSeq++,
        部位名称: (p['部位名称'] as string) ?? '',
        敏感度: (p['敏感度'] as number) ?? 0,
        开发度: (p['开发度'] as number) ?? 0,
        特征描述: (p['特征描述'] as string) ?? '',
        特殊印记: (p['特殊印记'] as string) ?? '',
      })),
      敏感点: Array.isArray(b['敏感点']) ? (b['敏感点'] as string[]).slice() : [],
      纹身与印记: Array.isArray(b['纹身与印记']) ? (b['纹身与印记'] as string[]).slice() : [],
      子宫: {
        状态: (rawUterus['状态'] as string) ?? '',
        宫口状态: (rawUterus['宫口状态'] as string) ?? '',
        内射记录: rawRecords.map((r) => ({ _id: bodyDraftIdSeq++, 日期: (r['日期'] as string) ?? '', 描述: (r['描述'] as string) ?? '' })),
      },
    };
    return { form, uterusRaw: { ...rawUterus } };
  }

  /** A blank body-part row for the "add" button. */
  function newBodyPart(): BodyEditPart {
    return { _id: bodyDraftIdSeq++, 部位名称: '', 敏感度: 0, 开发度: 0, 特征描述: '', 特殊印记: '' };
  }

  /** A blank insemination-record row for the "add" button. */
  function newInseminationRecord(): BodyEditRecord {
    return { _id: bodyDraftIdSeq++, 日期: '', 描述: '' };
  }

  return { toBodyDraft, newBodyPart, newInseminationRecord };
}

/** Draft form -> the payload for charEditor.updateBody(). */
export function fromBodyDraft(f: BodyEditForm, uterusRaw: Record<string, unknown>): Record<string, unknown> {
  // Drop blank body parts; trim names. Keep only the 5 known per-part fields.
  const cleanParts = f.身体部位
    .filter((p) => p.部位名称.trim() !== '')
    .map((p) => ({
      部位名称: p.部位名称.trim(),
      敏感度: p.敏感度,
      开发度: p.开发度,
      特征描述: p.特征描述,
      特殊印记: p.特殊印记,
    }));
  // Keep a record only if it has a date or description (drop fully-blank rows).
  const cleanRecords = f.子宫.内射记录
    .filter((r) => r.日期.trim() !== '' || r.描述.trim() !== '')
    .map((r) => ({ 日期: r.日期, 描述: r.描述 }));
  return {
    身高: f.身高,
    体重: f.体重,
    三围: { 胸围: f.胸围, 腰围: f.腰围, 臀围: f.臀围 },
    胸部描述: f.胸部描述,
    私处描述: f.私处描述,
    生殖器描述: f.生殖器描述,
    身体部位: cleanParts,
    敏感点: f.敏感点.slice(),
    纹身与印记: f.纹身与印记.slice(),
    // Merge over the open-time 子宫 snapshot to preserve any sub-fields not in the form.
    子宫: { ...uterusRaw, 状态: f.子宫.状态, 宫口状态: f.子宫.宫口状态, 内射记录: cleanRecords },
  };
}
