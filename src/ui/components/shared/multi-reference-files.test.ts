import { describe, it, expect, vi, afterEach } from 'vitest';
import { appendReferenceFiles } from './multi-reference-files';
import type { MultiReferenceItem } from './MultiReferencePicker.vue';

/**
 * 回归钉死（review Important 2026-08-29）：三个入口原本各写一份「不等待的
 * FileReader 循环」，而 FileReader 的完成顺序**不保证**等于发起顺序——大图读得
 * 慢，一次选中 [大, 小, 小] 会变成 [小, 小, 大]。而「图1/图2」的编号就是这个
 * 功能的全部意义，顺序错了功能即失效，界面上还完全看不出来。
 *
 * 下面的 FakeFileReader 故意让**先发起的读取后完成**：如果实现改回并发发起，
 * 顺序断言立刻红。
 */
class FakeFileReader {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: string | null = null;
  readAsDataURL(file: { name: string; delay: number }): void {
    setTimeout(() => {
      this.result = `data:image/png;base64,${file.name}`;
      this.onload?.();
    }, file.delay);
  }
}

function stubReader(): void {
  vi.stubGlobal('FileReader', FakeFileReader);
}

/** 只带测试需要的字段的假 File（顺带携带一个人为读取延迟）。 */
function fakeFile(name: string, delay: number, size = 10): unknown {
  return { name, delay, size };
}

const asFileList = (files: unknown[]): FileList =>
  ({ ...files, length: files.length, [Symbol.iterator]: Array.prototype[Symbol.iterator] }) as unknown as FileList;

const baseOpts = {
  max: 14,
  current: [] as MultiReferenceItem[],
  makeId: (() => { let n = 0; return () => `id${n++}`; })(),
};

describe('appendReferenceFiles', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('顺序 = 用户选择顺序，即使先发起的读取后完成', async () => {
    stubReader();
    // a 读得最慢；并发实现会把它排到最后
    const files = asFileList([fakeFile('a', 30), fakeFile('b', 5), fakeFile('c', 1)]);
    const out = await appendReferenceFiles(files, { ...baseOpts, makeId: (() => { let n = 0; return () => `x${n++}`; })() });
    expect(out.map((i) => i.label)).toEqual(['a', 'b', 'c']);
    expect(out.map((i) => i.dataUrl)).toEqual([
      'data:image/png;base64,a', 'data:image/png;base64,b', 'data:image/png;base64,c',
    ]);
  });

  it('追加到已有列表尾部，不改动传入数组', async () => {
    stubReader();
    const current: MultiReferenceItem[] = [{ id: 'old', dataUrl: 'd0', label: 'old' }];
    const out = await appendReferenceFiles(asFileList([fakeFile('n', 1)]), {
      ...baseOpts, current, makeId: () => 'new',
    });
    expect(out.map((i) => i.label)).toEqual(['old', 'n']);
    expect(current).toHaveLength(1);
  });

  it('校验不通过的文件被跳过，其余顺序不受影响', async () => {
    stubReader();
    const files = asFileList([fakeFile('ok1', 5), fakeFile('toobig', 1, 999), fakeFile('ok2', 1)]);
    const out = await appendReferenceFiles(files, {
      ...baseOpts,
      validate: (f) => (f as unknown as { size: number }).size < 100,
      makeId: (() => { let n = 0; return () => `y${n++}`; })(),
    });
    expect(out.map((i) => i.label)).toEqual(['ok1', 'ok2']);
  });

  it('超出剩余容量时截断到上限并回调一次 onOverflow', async () => {
    stubReader();
    const onOverflow = vi.fn();
    const out = await appendReferenceFiles(
      asFileList([fakeFile('1', 1), fakeFile('2', 1), fakeFile('3', 1)]),
      { ...baseOpts, max: 2, onOverflow, makeId: (() => { let n = 0; return () => `z${n++}`; })() },
    );
    expect(out).toHaveLength(2);
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it('已满时直接返回原列表并提示，不读任何文件', async () => {
    stubReader();
    const onOverflow = vi.fn();
    const current: MultiReferenceItem[] = [{ id: 'a', dataUrl: 'd', label: 'a' }];
    const out = await appendReferenceFiles(asFileList([fakeFile('x', 1)]), {
      ...baseOpts, max: 1, current, onOverflow, makeId: () => 'n',
    });
    expect(out).toBe(current);
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it('persist 的返回值落到 assetId；未提供 persist 则为 null', async () => {
    stubReader();
    const withPersist = await appendReferenceFiles(asFileList([fakeFile('p', 1)]), {
      ...baseOpts, persist: async () => 'asset_1', makeId: () => 'p1',
    });
    expect(withPersist[0].assetId).toBe('asset_1');

    const without = await appendReferenceFiles(asFileList([fakeFile('q', 1)]), { ...baseOpts, makeId: () => 'q1' });
    expect(without[0].assetId).toBeNull();
  });

  it('单张读取失败只跳过该张，不中断整批', async () => {
    class FailingSecond extends FakeFileReader {
      static seen = 0;
      readAsDataURL(file: { name: string; delay: number }): void {
        FailingSecond.seen++;
        if (file.name === 'bad') { setTimeout(() => this.onerror?.(), 1); return; }
        super.readAsDataURL(file);
      }
    }
    vi.stubGlobal('FileReader', FailingSecond);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await appendReferenceFiles(
      asFileList([fakeFile('good1', 1), fakeFile('bad', 1), fakeFile('good2', 1)]),
      { ...baseOpts, makeId: (() => { let n = 0; return () => `w${n++}`; })() },
    );
    expect(out.map((i) => i.label)).toEqual(['good1', 'good2']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
