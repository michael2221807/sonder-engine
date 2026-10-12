/**
 * Which ends of a sideways-scrolling row still hide something (2026-10-10, the status bar's chips on a phone): the
 * row fades only at an end that has more to show, so the first chip is never faded while nothing is scrolled.
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

export interface ScrollEdges {
  /** Something is hidden past the left end. */
  moreBefore: boolean;
  /** Something is hidden past the right end. */
  moreAfter: boolean;
}

export function scrollEdges(scrollLeft: number, scrollWidth: number, clientWidth: number): ScrollEdges {
  const max = scrollWidth - clientWidth;
  if (max <= 1) return { moreBefore: false, moreAfter: false };
  return { moreBefore: scrollLeft > 1, moreAfter: scrollLeft < max - 1 };
}

/** Tracks `el`'s edges through scrolling, its own resizing and its children's (a chip's text changing). */
export function useScrollEdges(el: Ref<HTMLElement | null>): { edges: Ref<ScrollEdges>; update: () => void } {
  const edges = ref<ScrollEdges>({ moreBefore: false, moreAfter: false });
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let mounted: HTMLElement | null = null;

  function update(): void {
    const node = el.value;
    if (!node) return;
    const next = scrollEdges(node.scrollLeft, node.scrollWidth, node.clientWidth);
    if (next.moreBefore !== edges.value.moreBefore || next.moreAfter !== edges.value.moreAfter) edges.value = next;
  }

  function observeChildren(node: HTMLElement): void {
    if (!resizeObserver) return;
    resizeObserver.disconnect();
    resizeObserver.observe(node);
    for (const child of Array.from(node.children)) resizeObserver.observe(child);
  }

  onMounted(() => {
    const node = el.value;
    if (!node) return;
    mounted = node;
    node.addEventListener('scroll', update, { passive: true });
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(update);
      observeChildren(node);
    }
    if (typeof MutationObserver === 'function') {
      mutationObserver = new MutationObserver(() => { observeChildren(node); update(); });
      mutationObserver.observe(node, { childList: true });
    }
    update();
  });

  onBeforeUnmount(() => {
    mounted?.removeEventListener('scroll', update);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
  });

  return { edges, update };
}
