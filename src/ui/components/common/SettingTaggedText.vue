<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.15
/**
 * SettingTaggedText — renders a player message with `<设定>` regions highlighted.
 *
 * The player's own bubble is plain text by design (no markdown, no HTML), and that stays
 * true here: the string is split into plain segments and rendered as text nodes, never
 * via `v-html`. The only thing added is a class on the marked spans.
 *
 * Why highlight at all: Canon Capture asks the player to make a deliberate mark, and a
 * mark you cannot see afterwards does not feel like it registered. Showing it in their
 * own message is the cheapest possible confirmation that the system heard them — and it
 * doubles as the tutorial, because the syntax is visible in context.
 *
 * Offsets come from the same `scanSettingTags` the pipeline uses, so what is highlighted
 * is exactly what the evidence gate will accept. A separate regex here would eventually
 * disagree with the engine and highlight something that was never captured.
 */
import { computed } from 'vue';
import { scanSettingTags } from '@/engine/prompt/setting-tag-scanner';

const props = defineProps<{ text: string }>();

interface Part {
  text: string;
  tagged: boolean;
}

const parts = computed<Part[]>(() => {
  const raw = props.text ?? '';
  if (!raw) return [];

  const { segments } = scanSettingTags(raw);
  if (segments.length === 0) return [{ text: raw, tagged: false }];

  const out: Part[] = [];
  let cursor = 0;

  for (const segment of segments) {
    // Everything before this segment's OPEN tag, including the tag markers themselves —
    // they stay visible so the player can see (and delete) exactly what they inserted.
    if (segment.startOffset > cursor) {
      out.push({ text: raw.slice(cursor, segment.startOffset), tagged: false });
    }
    out.push({ text: raw.slice(segment.startOffset, segment.endOffset), tagged: true });
    cursor = segment.endOffset;
  }

  if (cursor < raw.length) out.push({ text: raw.slice(cursor), tagged: false });
  return out;
});
</script>

<template>
  <span
    v-for="(part, i) in parts"
    :key="i"
    :class="{ 'setting-tagged': part.tagged }"
  >{{ part.text }}</span>
</template>

<style scoped>
/**
 * A quiet underline rather than a block highlight: the mark should read as "noted",
 * not as an error or a selection. Amber matches the composer's Setting key so the
 * player connects the two without being told.
 */
.setting-tagged {
  color: var(--color-amber-400);
  border-bottom: 1px dashed color-mix(in oklch, var(--color-amber-400) 50%, transparent);
}
</style>
