/**
 * An element's content width (inside its padding), kept up to date with a ResizeObserver (2026-10-10, the status
 * bar: it turns compact by the room its chips really have, not the screen's width — with both sidebars open on a
 * tablet the bar's padding leaves less room than a phone has; the padding follows the sidebars, so this follows too).
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

function contentWidth(node: HTMLElement): number {
  const style = getComputedStyle(node);
  return node.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
}

export function useElementWidth(el: Ref<HTMLElement | null>): Ref<number> {
  const width = ref(0);
  let observer: ResizeObserver | null = null;
  onMounted(() => {
    const node = el.value;
    if (!node) return;
    width.value = contentWidth(node);
    if (typeof ResizeObserver !== 'function') return;
    observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      width.value = box ? box.width : contentWidth(node);
    });
    observer.observe(node);
  });
  onBeforeUnmount(() => observer?.disconnect());
  return width;
}
