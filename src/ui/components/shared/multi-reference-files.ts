// App doc: docs/user-guide/pages/game-image.md §参考重绘（多图）
/**
 * 多图参考「加文件」的**唯一**实现（review 修复 2026-08-29）。
 *
 * 三个入口最初各写了一份，立刻长出三种行为差异：两处漏了体积校验、两处漏了
 * 溢出提示、两处用「不等待的 FileReader 循环」——而最后那条会**打乱顺序**：
 * FileReader 完成顺序不保证等于发起顺序，一次选中 [大图, 小图, 小图] 可能变成
 * [小图, 小图, 大图]。而「图1/图2」的编号就是这个功能的全部意义，顺序错了等于
 * 功能是坏的，界面上还完全看不出来。
 *
 * 所以这里强制**顺序 await**：一张读完再读下一张，顺序与用户选择顺序一致。
 */
import type { MultiReferenceItem } from './MultiReferencePicker.vue';

/** 读一个 File 成 data URL。 */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export interface AppendReferenceFilesOptions {
  /** 列表上限（含已有项） */
  max: number;
  /** 当前列表（不会被改动，返回新数组） */
  current: MultiReferenceItem[];
  /** 体积校验；返回 false 则跳过该文件（校验方自行提示） */
  validate?: (file: File) => boolean;
  /** 落资产库；返回 assetId，未持久化返回 null */
  persist?: (file: File, dataUrl: string) => Promise<string | null>;
  /** 选中数量超过剩余容量时调用一次（用于 toast） */
  onOverflow?: () => void;
  /** id 生成器（各面板用自己的） */
  makeId: () => string;
}

/**
 * 把选中的文件按**用户选择顺序**追加到列表尾部。
 * @returns 追加后的新列表（调用方直接赋值给 ref）
 */
export async function appendReferenceFiles(
  files: FileList,
  opts: AppendReferenceFilesOptions,
): Promise<MultiReferenceItem[]> {
  const room = opts.max - opts.current.length;
  if (room <= 0) {
    opts.onOverflow?.();
    return opts.current;
  }
  const picked = Array.from(files).slice(0, room);
  if (files.length > room) opts.onOverflow?.();

  const added: MultiReferenceItem[] = [];
  // 顺序 await —— 不要改成 Promise.all/map：那样完成顺序不确定，编号会乱。
  for (const file of picked) {
    if (opts.validate && !opts.validate(file)) continue;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const assetId = opts.persist ? await opts.persist(file, dataUrl) : null;
      added.push({ id: opts.makeId(), dataUrl, assetId, label: file.name });
    } catch (err) {
      console.warn('[MultiReference] 参考图读取失败，已跳过:', file.name, err);
    }
  }
  return [...opts.current, ...added];
}
