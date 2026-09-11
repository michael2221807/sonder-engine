<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.17（回合前存档自检）
/**
 * SaveHealthGateModal — the decision the composer asks for when the pre-round check
 * found that a side store lost data the save still relies on.
 *
 * Deliberately not closable by backdrop / Esc (it stands between the player and a
 * round that would advance on a damaged foundation — the same policy as the cloud
 * conflict modal). Two exits only: go fix it, or knowingly continue.
 */
import { useI18n } from 'vue-i18n';
import Modal from '@/ui/components/common/Modal.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import type { SaveHealthReport } from '@/engine/persistence/save-health';

const props = defineProps<{
  open: boolean;
  report: SaveHealthReport | null;
}>();

const emit = defineEmits<{
  (e: 'go-to-save'): void;
  (e: 'continue'): void;
}>();

const { t } = useI18n();

function findings(report: SaveHealthReport): string[] {
  const rows: string[] = [];
  if (report.issues.includes('images_missing')) {
    rows.push(t('mainGame.saveHealth.images', { missing: report.images.missingIds.length, total: report.images.referenced }));
  }
  if (report.issues.includes('world_books_unreadable')) rows.push(t('mainGame.saveHealth.worldBooksUnreadable'));
  else if (report.issues.includes('world_books_lost')) rows.push(t('mainGame.saveHealth.worldBooksLost', { expected: report.worldBooks.expected }));
  if (report.issues.includes('vectors_unreadable')) rows.push(t('mainGame.saveHealth.vectorsUnreadable'));
  else if (report.issues.includes('vectors_lost')) rows.push(t('mainGame.saveHealth.vectorsLost', { events: report.vectors.embeddedEvents }));
  return rows;
}
</script>

<template>
  <Modal :model-value="props.open" :title="$t('mainGame.saveHealth.title')" :closable="false" width="460px">
    <div class="shg" data-testid="save-health-gate">
      <p class="shg__lead">{{ $t('mainGame.saveHealth.lead', { round: props.report?.round ?? 0 }) }}</p>
      <ul v-if="props.report" class="shg__list">
        <li v-for="row in findings(props.report)" :key="row" class="shg__row">{{ row }}</li>
      </ul>
      <p class="shg__hint">{{ $t('mainGame.saveHealth.hint') }}</p>
    </div>
    <template #footer>
      <AgaButton variant="ghost" data-testid="save-health-continue" @click="emit('continue')">
        {{ $t('mainGame.saveHealth.continue') }}
      </AgaButton>
      <AgaButton variant="primary" data-testid="save-health-go-save" @click="emit('go-to-save')">
        {{ $t('mainGame.saveHealth.goToSave') }}
      </AgaButton>
    </template>
  </Modal>
</template>

<style scoped>
.shg { display: flex; flex-direction: column; gap: 12px; }
.shg__lead { margin: 0; font-size: 0.9rem; line-height: 1.6; color: var(--color-text); }
.shg__list {
  margin: 0;
  padding: 10px 14px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--color-danger) 8%, transparent);
}
.shg__row { font-size: 0.84rem; line-height: 1.55; color: var(--color-text); }
.shg__row::before { content: '·'; margin-right: 6px; color: var(--color-danger); }
.shg__hint { margin: 0; font-size: 0.78rem; line-height: 1.55; color: var(--color-text-muted); }
</style>
