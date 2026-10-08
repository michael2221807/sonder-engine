<script lang="ts">
// Re-export NpcBrief so existing consumers keep importing it from this SFC
// (e.g. MainGamePanel: `import type { NpcBrief } from '.../FormattedText.vue'`).
export type { NpcBrief } from './FormattedInline.vue';
</script>

<script setup lang="ts">
/**
 * FormattedText — 叙事正文富格式渲染（块级 + 行内）
 *
 * 将 AI 返回的叙事正文解析为块级结构（段落 / 标题 / 有序·无序列表 / 引用 /
 * 分割线）并渲染，块内行内片段委托 FormattedInline 呈现。支持：
 *
 *   AGA 语义记号（既有，不变）：
 *   - 【...】  环境描写      - `...`   角色内心（反引号，非代码）
 *   - "..." / “...”  对话     - 〖类型:结果,...〗  判定卡片
 *   - NPC 名高亮 + 悬浮档案卡
 *
 *   markdown（新增，"常用排版全套"）：
 *   - **粗** / __粗__   - *斜* / _斜_   - # 标题(1~6)
 *   - 有序/无序列表     - > 引用       - --- 分割线   - [文本](链接)
 *
 * 反引号保留「内心」语义，不当作代码；表格 / 代码块不在范围内。
 * 引用与嵌套列表以原始子文本递归调用本组件渲染（转发 NPC props），支持任意嵌套。
 *
 * 解析逻辑见 formatted-text-parser.ts（纯函数，单测覆盖）。
 */
import { computed } from 'vue';
import FormattedInline from './FormattedInline.vue';
import type { NpcBrief } from './FormattedInline.vue';
import {
  parseNarrative,
  highlightNpcNames,
  type Block,
  type InlinePart,
  type TableAlign,
} from './formatted-text-parser';

// App doc: docs/user-guide/pages/game-main.md §3.4
defineOptions({ name: 'FormattedText' });

/** Per-column text-align style for table cells. */
function alignStyle(a: TableAlign): Record<string, string> {
  return a ? { textAlign: a } : {};
}

const props = defineProps<{
  text: string;
  npcNames?: string[];
  npcData?: NpcBrief[];
}>();

/** Apply NPC-name highlight to every inline array inside the block tree.
 *  Blockquote / nested-list content is highlighted by the recursive child
 *  FormattedText instance (npcNames are forwarded), so only same-level inline
 *  arrays are processed here. */
function highlightBlocks(blocks: Block[], names: string[]): Block[] {
  if (names.length === 0) return blocks;
  const hl = (parts: InlinePart[]): InlinePart[] => highlightNpcNames(parts, names);
  return blocks.map((b) => {
    if (b.type === 'paragraph') return { ...b, lines: b.lines.map(hl) };
    if (b.type === 'heading') return { ...b, parts: hl(b.parts) };
    if (b.type === 'list') return { ...b, items: b.items.map((it) => ({ ...it, parts: hl(it.parts) })) };
    if (b.type === 'table') return {
      ...b,
      headers: b.headers.map(hl),
      rows: b.rows.map((row) => row.map(hl)),
    };
    return b;
  });
}

const blocks = computed<Block[]>(() =>
  highlightBlocks(parseNarrative(props.text ?? ''), props.npcNames ?? []),
);
</script>

<template>
  <div class="formatted-text">
    <template v-for="(block, bi) in blocks" :key="bi">
      <!-- Paragraph — soft line breaks preserved via <br> -->
      <p v-if="block.type === 'paragraph'" class="ft-p">
        <template v-for="(line, li) in block.lines" :key="li">
          <br v-if="li > 0" />
          <FormattedInline :parts="line" :npc-data="npcData" />
        </template>
      </p>

      <!-- Heading -->
      <component
        :is="`h${block.level}`"
        v-else-if="block.type === 'heading'"
        class="ft-h"
        :class="`ft-h${block.level}`"
      >
        <FormattedInline :parts="block.parts" :npc-data="npcData" />
      </component>

      <!-- Thematic break — centered dot ornament (NOT a full-width line, so it
           never reads as a structural round divider). -->
      <div
        v-else-if="block.type === 'hr'"
        class="ft-hr"
        role="separator"
        aria-orientation="horizontal"
      />


      <!-- Blockquote — recurse on raw inner text -->
      <blockquote v-else-if="block.type === 'blockquote'" class="ft-quote">
        <FormattedText :text="block.text" :npc-names="npcNames" :npc-data="npcData" />
      </blockquote>

      <!-- List -->
      <component
        :is="block.ordered ? 'ol' : 'ul'"
        v-else-if="block.type === 'list'"
        class="ft-list"
        :class="block.ordered ? 'ft-list--ol' : 'ft-list--ul'"
      >
        <li v-for="(item, ii) in block.items" :key="ii" class="ft-li">
          <FormattedInline :parts="item.parts" :npc-data="npcData" />
          <!-- Nested content (sub-list / continuation) — recurse -->
          <FormattedText
            v-if="item.childText"
            :text="item.childText"
            :npc-names="npcNames"
            :npc-data="npcData"
          />
        </li>
      </component>

      <!-- Table (GFM pipe table) — horizontally scrollable when wide -->
      <div v-else-if="block.type === 'table'" class="ft-table-wrap">
        <table class="ft-table">
          <thead>
            <tr>
              <th
                v-for="(cell, ci) in block.headers"
                :key="ci"
                :style="alignStyle(block.align[ci])"
              >
                <FormattedInline :parts="cell" :npc-data="npcData" />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, ri) in block.rows" :key="ri">
              <td
                v-for="(cell, ci) in row"
                :key="ci"
                :style="alignStyle(block.align[ci])"
              >
                <FormattedInline :parts="cell" :npc-data="npcData" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.formatted-text {
  font-family: var(--font-serif-cjk);
  line-height: var(--narrative-line-height, 1.88);
  letter-spacing: var(--narrative-letter-spacing, 0.01em);
  word-break: break-word;
}

/* ── Paragraph — preserve intra-line whitespace like the old pre-wrap path,
      add breathing room between paragraphs (blank-line separated blocks). ── */
.ft-p {
  margin: 0;
  white-space: pre-wrap;
}
/* Inter-paragraph gap = one line-height, reproducing the old pre-wrap `\n\n`
   blank-line spacing exactly (measured old gap ≈ 1 line-height; user flagged
   the tighter 0.72em as cramped, 2026-07-16). */
.ft-p + .ft-p,
.ft-p + .ft-list,
.ft-p + .ft-quote,
.ft-list + .ft-p,
.ft-quote + .ft-p {
  margin-top: 1.88em;
}

/* ── Headings — restrained scale so a stray '#' never dominates the prose.
      Sage-tinted, per the sanctuary brief. ── */
.ft-h {
  font-family: var(--font-serif-cjk);
  font-weight: 700;
  color: var(--color-text);
  line-height: 1.4;
  margin: 0.9em 0 0.4em;
  letter-spacing: 0.02em;
}
.ft-h:first-child { margin-top: 0; }
.ft-h1 { font-size: 1.28em; }
.ft-h2 { font-size: 1.18em; }
.ft-h3 { font-size: 1.08em; }
.ft-h4 { font-size: 1em; }
.ft-h5,
.ft-h6 {
  font-size: 0.94em;
  color: var(--color-text-secondary);
}

/* ── Thematic break (markdown `---`) — centered dot ornament (asterism).
      Deliberately NOT a full-width horizontal line: a sage hairline would be
      confused with the structural round divider (RoundDivider.vue — full-width
      sage line + 第 N 回合 badge). A centered dot cluster reads as an in-scene
      pause, never as a round boundary. (user flagged the line as misleading,
      2026-07-16) ── */
.ft-hr {
  border: none;
  height: auto;
  margin: 1.4em 0;
  padding: 0;
  background: none;
  text-align: center;
  line-height: 1;
}
.ft-hr::before {
  content: '···';
  color: var(--color-text-umber);
  font-size: 1.3em;
  letter-spacing: 0.55em;
  /* letter-spacing adds trailing space after the last dot — nudge left to keep
     the cluster optically centered. */
  padding-left: 0.55em;
  opacity: 0.5;
}

/* ── Blockquote — inset warm wash with a soft sage edge (no hard side-stripe) ── */
.ft-quote {
  margin: 0.6em 0;
  padding: 6px 14px;
  border-radius: var(--radius-md, 8px);
  background: color-mix(in oklch, var(--color-sage-400) 5%, transparent);
  box-shadow: inset 2px 0 0 color-mix(in oklch, var(--color-sage-400) 30%, transparent);
  color: var(--color-text-secondary);
  font-style: italic;
}
.ft-quote :deep(.ft-p) { white-space: pre-wrap; }

/* ── Lists ── */
.ft-list {
  margin: 0.5em 0;
  padding-left: 1.6em;
}
.ft-list--ul { list-style: none; }
.ft-list--ol { list-style: decimal; }
.ft-li {
  margin: 0.24em 0;
  white-space: pre-wrap;
}
/* Custom sage bullet for unordered items (tacit "item" affordance) */
.ft-list--ul > .ft-li {
  position: relative;
}
.ft-list--ul > .ft-li::before {
  content: '';
  position: absolute;
  left: -1.05em;
  top: 0.82em;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: color-mix(in oklch, var(--color-sage-400) 70%, transparent);
}
.ft-list--ol > .ft-li::marker {
  color: var(--color-sage-400);
  font-family: var(--font-mono);
  font-size: 0.9em;
}
/* Nested list tightening */
.ft-li > .formatted-text {
  margin-top: 0.24em;
}

/* ── Table (GFM pipe table) ──────────────────────────────────────
   Clean data surface: sage-tinted header, hairline row dividers, rounded
   frame. Wraps in an overflow-x container so a wide table scrolls inside
   itself instead of pushing the page. font-style reset to normal so a table
   nested in a `>` blockquote (which is italic) still reads upright. ── */
.ft-table-wrap {
  margin: 0.9em 0;
  max-width: 100%;
  overflow-x: auto;
  border-radius: var(--radius-md, 8px);
  background: color-mix(in oklch, var(--color-text-umber) 4%, transparent);
  box-shadow: inset 0 0 0 1px var(--color-border-subtle);
}
.ft-table {
  border-collapse: collapse;
  width: 100%;
  font-family: var(--font-sans);
  font-style: normal;
  font-size: 0.9em;
  line-height: 1.5;
  letter-spacing: normal;
}
.ft-table th,
.ft-table td {
  padding: 7px 14px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--color-border-subtle);
}
.ft-table thead th {
  color: var(--color-sage-300);
  font-weight: 600;
  white-space: nowrap;
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
  border-bottom: 1px solid color-mix(in oklch, var(--color-sage-400) 28%, var(--color-border));
}
.ft-table tbody tr:last-child td {
  border-bottom: none;
}
.ft-table tbody tr:hover {
  background: rgba(255, 255, 255, 0.02);
}
/* Inline leaves inside cells shouldn't re-italicize from the quote context */
.ft-table :deep(.formatted-inline) {
  font-style: normal;
}
</style>
