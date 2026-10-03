/**
 * A system notice already in a save shows its whole sentence (ZERO real API).
 *
 * PO trial 2026-10-02: notices like `〖系统提示：车门关上，……〗` showed only "车门关上" — the display split them at
 * the first comma like a dice verdict. A notice the verdict parse would cut short now reads as a sentence after
 * its label (never coloured as an outcome), flowing and wrapping inside its card; a short notice and a verdict
 * keep their look.
 *
 * Run: npx playwright test system-notice-display
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { makeSeedTree } from './fixtures/seed-tree';

const NOTICE = '车门关上，后座那人，没再看你。';
const SHORT = '走了，很静。';
const FAILED = '任务失败，请重试';
const LONG = '你把这一整天的流光、冷香、辨不透的护，塞得满满当当的脑子，在看见这栋破旧的、熟悉的楼时，古怪地，稳了下来。这是你的岸。';
// A thought written with a colon in its first clause: the long clause becomes the label.
const LABEL = '他想起了那天夜里在医院走廊里听到的话';
const SAID = '快走，别回头，不要相信他';

test('an old system notice reads as its whole sentence; a short notice and a verdict keep their look',
  { tag: ['@regression', '@narrative'] }, async ({ page }) => {
    await seedSave(page, {
      tree: makeSeedTree({
        元数据: {
          叙事历史: [
            { role: 'user', content: '我上了车。' },
            { role: 'assistant', content: [
              '【车厢里很静。】', `〖系统提示：${NOTICE}〗`, '你望着窗外。', `〖系统提示：${SHORT}〗`, `〖系统提示：${FAILED}〗`,
              `〖系统提示：${LONG}〗`, `〖${LABEL}：${SAID}〗`, '〖系统提示：好感度变化〗', '〖社交:成功,判定值:16,难度:9〗他点了点头。',
            ].join('\n\n') },
          ],
        },
      }),
    });
    await enterSeededGame(page);

    const notices = page.locator('.judgement-card--notice');
    await expect(notices).toHaveCount(5);
    await expect(notices.locator('.jc-note')).toHaveText([NOTICE, SHORT, FAILED, LONG, SAID]);
    await expect(notices.locator('.jc-type')).toHaveText(['系统提示', '系统提示', '系统提示', '系统提示', LABEL]);
    await expect(notices.locator('.jc-badge')).toHaveCount(0);
    // A notice is never coloured as an outcome, whatever words its sentence holds.
    await expect(notices.nth(2)).not.toHaveClass(/judgement-card--(success|failure|great-success|great-failure)/);

    // Every sentence is readable: inside its card, never squeezed to a sliver, the card inside the screen; after a
    // short label it starts on the label's line.
    const width = page.viewportSize()?.width ?? 0;
    const layout = await notices.evaluateAll(cards => cards.map(card => {
      const box = card.getBoundingClientRect(), style = getComputedStyle(card);
      const inner = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const label = card.querySelector('.jc-type')!.getBoundingClientRect();
      const note = card.querySelector('.jc-note')!;
      const noteBox = note.getBoundingClientRect(), lines = [...note.getClientRects()];
      const lineHeight = parseFloat(getComputedStyle(note).lineHeight) || 20;
      return {
        labelTop: label.top, noteTop: lines[0]?.top ?? -1, cardRight: box.right,
        inside: lines.length > 0 && lines.every(r => r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1),
        // A sentence that wraps must use the card's width, not a narrow column beside a long label.
        squeezed: noteBox.width < 1 || (noteBox.height > lineHeight * 1.6 && noteBox.width < inner * 0.6),
      };
    }));
    layout.forEach((l, i) => {
      expect(l.inside, `notice ${i}: its sentence inside the card`).toBe(true);
      expect(l.squeezed, `notice ${i}: its sentence not squeezed`).toBe(false);
      expect(l.cardRight, `notice ${i}: the card on screen`).toBeLessThanOrEqual(width + 1);
    });
    for (const i of [0, 1, 2, 3]) expect(Math.abs(layout[i].noteTop - layout[i].labelTop), `notice ${i}: beside the label`).toBeLessThan(8);

    const short = page.locator('.judgement-card', { hasText: '好感度变化' });
    await expect(short.locator('.jc-badge')).toHaveText('好感度变化');
    const verdict = page.locator('.judgement-card--success');
    await expect(verdict.locator('.jc-badge')).toHaveText('成功');
    await expect(verdict.locator('.jc-stat-value').first()).toHaveText('16');
  });
