import { describe, expect, it } from 'vitest';
import { createBodyEditDraft, emptyBodyEditForm, fromBodyDraft } from './body-edit-draft';

const body = {
  身高: 170, 体重: 55,
  三围: { 胸围: 90, 腰围: 60, 臀围: 92 },
  胸部描述: 'c', 私处描述: 'p', 生殖器描述: 'g',
  身体部位: [
    { 部位名称: '耳', 敏感度: 3, 开发度: 1, 特征描述: 'small', 特殊印记: 'mole', extra: 'dropped' },
    { 部位名称: '颈' },
  ],
  敏感点: ['a', 'b'],
  纹身与印记: ['t'],
  子宫: { 状态: '正常', 宫口状态: '闭', 内射记录: [{ 日期: 'd1', 描述: 'x', 怀孕判定日: 'keep' }, { 日期: 'd2' }], 未知字段: 42 },
};

describe('emptyBodyEditForm', () => {
  it('is a fresh zeroed form each call', () => {
    const a = emptyBodyEditForm();
    expect(a).toEqual({
      身高: 0, 体重: 0, 胸围: 0, 腰围: 0, 臀围: 0,
      胸部描述: '', 私处描述: '', 生殖器描述: '',
      身体部位: [], 敏感点: [], 纹身与印记: [],
      子宫: { 状态: '', 宫口状态: '', 内射记录: [] },
    });
    a.敏感点.push('x');
    expect(emptyBodyEditForm().敏感点).toEqual([]);
  });
});

describe('toBodyDraft', () => {
  it('maps state to the draft with numbered rows (parts first, then insemination records)', () => {
    const { form, uterusRaw } = createBodyEditDraft().toBodyDraft(body);
    expect(form).toMatchObject({ 身高: 170, 体重: 55, 胸围: 90, 腰围: 60, 臀围: 92, 胸部描述: 'c', 私处描述: 'p', 生殖器描述: 'g' });
    expect(form.身体部位).toEqual([
      { _id: 0, 部位名称: '耳', 敏感度: 3, 开发度: 1, 特征描述: 'small', 特殊印记: 'mole' },
      { _id: 1, 部位名称: '颈', 敏感度: 0, 开发度: 0, 特征描述: '', 特殊印记: '' },
    ]);
    expect(form.子宫).toEqual({ 状态: '正常', 宫口状态: '闭', 内射记录: [{ _id: 2, 日期: 'd1', 描述: 'x' }, { _id: 3, 日期: 'd2', 描述: '' }] });
    expect(uterusRaw).toEqual(body.子宫);
    expect(uterusRaw).not.toBe(body.子宫);
  });

  it('copies the tag lists instead of sharing them with the state', () => {
    const { form } = createBodyEditDraft().toBodyDraft(body);
    form.敏感点.push('new');
    form.纹身与印记.length = 0;
    expect(body.敏感点).toEqual(['a', 'b']);
    expect(body.纹身与印记).toEqual(['t']);
  });

  it('tolerates an empty / malformed body', () => {
    const { form, uterusRaw } = createBodyEditDraft().toBodyDraft({ 身体部位: 'x', 敏感点: 5, 子宫: { 内射记录: 'no' } });
    expect(form).toEqual(emptyBodyEditForm());
    expect(uterusRaw).toEqual({ 内射记录: 'no' });
    expect(createBodyEditDraft().toBodyDraft({}).form).toEqual(emptyBodyEditForm());
  });
});

describe('row ids', () => {
  it('continue across opens and new rows within one draft instance', () => {
    const draft = createBodyEditDraft();
    draft.toBodyDraft(body); // uses 0..3
    expect(draft.newBodyPart()).toEqual({ _id: 4, 部位名称: '', 敏感度: 0, 开发度: 0, 特征描述: '', 特殊印记: '' });
    expect(draft.newInseminationRecord()).toEqual({ _id: 5, 日期: '', 描述: '' });
    expect(draft.toBodyDraft(body).form.身体部位[0]._id).toBe(6);
  });

  it('are per instance (one counter per panel, never module-global)', () => {
    const a = createBodyEditDraft();
    const b = createBodyEditDraft();
    a.newBodyPart(); a.newBodyPart();
    expect(b.newBodyPart()._id).toBe(0);
    expect(a.newBodyPart()._id).toBe(2);
  });
});

describe('fromBodyDraft', () => {
  it('round-trips an unedited draft, merging over the open-time 子宫 snapshot', () => {
    const { form, uterusRaw } = createBodyEditDraft().toBodyDraft(body);
    const out = fromBodyDraft(form, uterusRaw);
    expect(out).toEqual({
      身高: 170, 体重: 55,
      三围: { 胸围: 90, 腰围: 60, 臀围: 92 },
      胸部描述: 'c', 私处描述: 'p', 生殖器描述: 'g',
      身体部位: [
        { 部位名称: '耳', 敏感度: 3, 开发度: 1, 特征描述: 'small', 特殊印记: 'mole' },
        { 部位名称: '颈', 敏感度: 0, 开发度: 0, 特征描述: '', 特殊印记: '' },
      ],
      敏感点: ['a', 'b'],
      纹身与印记: ['t'],
      // 内射记录 rows are rebuilt from the two form fields only; sub-fields the form does not show
      // (未知字段) survive through the snapshot
      子宫: { 状态: '正常', 宫口状态: '闭', 内射记录: [{ 日期: 'd1', 描述: 'x' }, { 日期: 'd2', 描述: '' }], 未知字段: 42 },
    });
  });

  it('drops blank parts (names trimmed) and fully blank records, keeps whitespace-only descriptions out', () => {
    const draft = createBodyEditDraft();
    const { form, uterusRaw } = draft.toBodyDraft({});
    form.身体部位.push({ ...draft.newBodyPart(), 部位名称: '  口 ' }, draft.newBodyPart(), { ...draft.newBodyPart(), 部位名称: '   ' });
    form.子宫.内射记录.push(
      { ...draft.newInseminationRecord(), 日期: ' ' },
      { ...draft.newInseminationRecord(), 描述: 'only text' },
      draft.newInseminationRecord(),
    );
    const out = fromBodyDraft(form, uterusRaw);
    expect((out.身体部位 as Array<{ 部位名称: string }>).map((p) => p.部位名称)).toEqual(['口']);
    expect((out.子宫 as { 内射记录: unknown[] }).内射记录).toEqual([{ 日期: '', 描述: 'only text' }]);
  });

  it('lets the draft values win over the snapshot for the fields the form owns', () => {
    const { form } = createBodyEditDraft().toBodyDraft({});
    form.子宫.状态 = '新';
    const out = fromBodyDraft(form, { 状态: '旧', 宫口状态: '旧', 其他: 1 });
    expect(out.子宫).toEqual({ 状态: '新', 宫口状态: '', 内射记录: [], 其他: 1 });
  });

  it('returns copies of the tag arrays, not the draft arrays', () => {
    const { form, uterusRaw } = createBodyEditDraft().toBodyDraft(body);
    const out = fromBodyDraft(form, uterusRaw);
    expect(out.敏感点).not.toBe(form.敏感点);
    expect(out.纹身与印记).not.toBe(form.纹身与印记);
  });
});
