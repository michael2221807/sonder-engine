/**
 * tooltip-placement — 纯函数单测（fixed 提示气泡放哪：上方 / 下方，整块留在视口内）。
 *
 * 覆盖重点是 PO 2026-10-04 报的那条：状态栏紧贴顶栏，长提示放上方会飞出屏幕顶端；
 * 以及「放得下就用偏好侧、放不下就翻面、两边都放不下就夹在视口里」。
 */
import { describe, it, expect } from 'vitest';
import { placeFixedTip, FIXED_TIP_GAP, FIXED_TIP_MARGIN } from './tooltip-placement';

const VIEWPORT = { width: 1920, height: 1080 };
/** A status-bar chip: right under the top bar. */
const STATUS_CHIP = { top: 70, bottom: 92, left: 300, width: 120 };
/** Four lines of 12px text plus padding: the kind of hint that used to leave the screen. */
const LONG_TIP = { width: 240, height: 82 };
const SHORT_TIP = { width: 100, height: 29 };

describe('placeFixedTip', () => {
  it('偏好下方且放得下：贴在触发元素正下方，水平居中', () => {
    expect(placeFixedTip(STATUS_CHIP, LONG_TIP, VIEWPORT, 'bottom')).toEqual({
      side: 'bottom',
      top: STATUS_CHIP.bottom + FIXED_TIP_GAP,
      left: STATUS_CHIP.left + STATUS_CHIP.width / 2 - LONG_TIP.width / 2,
    });
  });

  it('偏好上方但上方放不下（紧贴顶栏的长提示）：翻到下方，不飞出屏幕', () => {
    const p = placeFixedTip(STATUS_CHIP, LONG_TIP, VIEWPORT, 'top');
    expect(p.side).toBe('bottom');
    expect(p.top).toBe(STATUS_CHIP.bottom + FIXED_TIP_GAP);
  });

  it('偏好上方且放得下：贴在触发元素正上方', () => {
    expect(placeFixedTip(STATUS_CHIP, SHORT_TIP, VIEWPORT, 'top')).toMatchObject({
      side: 'top',
      top: STATUS_CHIP.top - FIXED_TIP_GAP - SHORT_TIP.height,
    });
  });

  it('偏好下方但贴着视口底：翻到上方', () => {
    const nearBottom = { top: 1040, bottom: 1062, left: 300, width: 120 };
    expect(placeFixedTip(nearBottom, LONG_TIP, VIEWPORT, 'bottom')).toMatchObject({
      side: 'top',
      top: nearBottom.top - FIXED_TIP_GAP - LONG_TIP.height,
    });
  });

  it('两边都放不下：取空间更大的一侧，并夹在视口内（可以盖住触发元素）', () => {
    const small = { width: 400, height: 120 };
    const middle = { top: 40, bottom: 62, left: 100, width: 80 };
    const p = placeFixedTip(middle, LONG_TIP, small, 'top');
    expect(p.side).toBe('bottom');
    expect(p.top).toBe(small.height - FIXED_TIP_MARGIN - LONG_TIP.height);
    expect(p.top).toBeGreaterThanOrEqual(FIXED_TIP_MARGIN);
  });

  it('两边空间一样大且都放不下：保留偏好侧', () => {
    const small = { width: 400, height: 100 };
    const centred = { top: 40, bottom: 60, left: 100, width: 80 };
    expect(placeFixedTip(centred, LONG_TIP, small, 'top').side).toBe('top');
    expect(placeFixedTip(centred, LONG_TIP, small, 'bottom').side).toBe('bottom');
  });

  it('气泡比视口还高：顶边留在屏幕上，开头读得到', () => {
    const tiny = { width: 400, height: 60 };
    expect(placeFixedTip({ top: 20, bottom: 40, left: 100, width: 80 }, LONG_TIP, tiny, 'bottom').top).toBe(FIXED_TIP_MARGIN);
  });

  it('刚好放得下（气泡高度 = 偏好侧空间）：仍用偏好侧，贴着边距', () => {
    const roomAbove = STATUS_CHIP.top - FIXED_TIP_GAP - FIXED_TIP_MARGIN;
    expect(placeFixedTip(STATUS_CHIP, { width: 100, height: roomAbove }, VIEWPORT, 'top')).toMatchObject({ side: 'top', top: FIXED_TIP_MARGIN });
    expect(placeFixedTip(STATUS_CHIP, { width: 100, height: roomAbove + 1 }, VIEWPORT, 'top').side).toBe('bottom');
  });

  it('气泡比视口还宽：左边留在屏幕上，开头读得到', () => {
    const narrow = { width: 200, height: 600 };
    expect(placeFixedTip({ top: 70, bottom: 92, left: 150, width: 40 }, LONG_TIP, narrow, 'bottom').left).toBe(FIXED_TIP_MARGIN);
  });

  it('水平方向：贴右边 / 贴左边时收回视口内，保持自身宽度', () => {
    const right = { top: 70, bottom: 92, left: 1880, width: 30 };
    expect(placeFixedTip(right, LONG_TIP, VIEWPORT, 'bottom').left).toBe(VIEWPORT.width - FIXED_TIP_MARGIN - LONG_TIP.width);
    const left = { top: 70, bottom: 92, left: 4, width: 30 };
    expect(placeFixedTip(left, LONG_TIP, VIEWPORT, 'bottom').left).toBe(FIXED_TIP_MARGIN);
  });

  it('只要气泡不比视口大，任何位置的触发元素、任一偏好侧，结果都整块在视口内', () => {
    const viewport = { width: 800, height: 600 };
    for (const prefer of ['top', 'bottom'] as const) {
      for (let y = 0; y <= 580; y += 20) {
        for (let x = 0; x <= 780; x += 60) {
          for (const tip of [SHORT_TIP, LONG_TIP, { width: 240, height: 300 }]) {
            const p = placeFixedTip({ top: y, bottom: y + 20, left: x, width: 20 }, tip, viewport, prefer);
            expect(p.top).toBeGreaterThanOrEqual(FIXED_TIP_MARGIN);
            expect(p.top + tip.height).toBeLessThanOrEqual(viewport.height - FIXED_TIP_MARGIN);
            expect(p.left).toBeGreaterThanOrEqual(FIXED_TIP_MARGIN);
            expect(p.left + tip.width).toBeLessThanOrEqual(viewport.width - FIXED_TIP_MARGIN);
          }
        }
      }
    }
  });
});
