/**
 * useEngramEditor — Vue composable for the Engram relationship editor UI.
 *
 * Wraps EngramEditor (engine API) with:
 * - Vue inject pattern (matches useAssistant.ts)
 * - Error code → i18n toast mapping
 * - Type-safe CRUD + analytics + vectorization API
 *
 * Story 1 of Game Card Epic (§4.10, C2, NEW-C1).
 */
// App doc: docs/user-guide/pages/game-relationship-graph.md
import { injectService } from '@/ui/injection-keys';
import { useI18n } from 'vue-i18n';
import { eventBus } from '@/engine/core/event-bus';
import type { EngramEditor } from '@/engine/memory/engram/engram-editor';
import { EngramEditError } from '@/engine/memory/engram/engram-editor';
import type { EngramEntity } from '@/engine/memory/engram/entity-builder';
import type { EngramEdge } from '@/engine/memory/engram/knowledge-edge';
import type {
  NewEngramEntity,
  NewKnowledgeEdge,
  CoverageStats,
} from '@/engine/memory/engram/engram-editor';

export function useEngramEditor() {
  const editor = injectService('engramEditor');
  if (!editor) {
    throw new Error('[useEngramEditor] EngramEditor not provided — check main.ts wiring');
  }
  const { t } = useI18n();

  function handleError(err: unknown): null {
    if (err instanceof Error && Object.values(EngramEditError).includes(err.message as EngramEditError)) {
      const code = err.message as EngramEditError;
      const i18nKey = `engram.editor.error.${code}`;
      eventBus.emit('ui:toast', {
        type: 'error',
        i18nKey,
        message: t(i18nKey),
      });
      return null;
    }
    throw err;
  }

  return {
    // ─── Entity CRUD ───
    createEntity: (
      input: NewEngramEntity,
      opts?: { vectorize?: 'immediate' },
    ): Promise<EngramEntity | null> =>
      editor.createEntity(input, opts).catch(handleError),

    updateEntity: (
      name: string,
      patch: Partial<Pick<EngramEntity, 'summary' | 'type' | 'attributes'>>,
    ): Promise<EngramEntity | null> =>
      editor.updateEntity(name, patch).catch(handleError),

    renameEntity: (
      oldName: string,
      newName: string,
    ): Promise<{ entity: EngramEntity; updatedEdgeCount: number } | null> =>
      editor.renameEntity(oldName, newName).catch(handleError),

    deleteEntity: (
      name: string,
      options?: { cascade?: boolean },
    ): Promise<{ deletedEdgeIds: string[] } | null> =>
      editor.deleteEntity(name, options).catch(handleError),

    // ─── Edge CRUD ───
    createEdge: (
      input: NewKnowledgeEdge,
      opts?: { vectorize?: 'immediate' },
    ): Promise<{ edge: EngramEdge; autoStubbed?: string[] } | null> =>
      editor.createEdge(input, opts).catch(handleError),

    updateEdge: (
      edgeId: string,
      patch: Partial<Pick<EngramEdge, 'fact' | 'sourceEntity' | 'targetEntity' | 'core' | 'confidence'>>,
    ): Promise<{ edge: EngramEdge; oldEdgeId?: string } | null> =>
      editor.updateEdge(edgeId, patch).catch(handleError),

    deleteEdge: (edgeId: string): Promise<void | null> =>
      editor.deleteEdge(edgeId).catch(handleError),

    markEdgeCore: (edgeId: string, core: boolean): Promise<EngramEdge | null> =>
      editor.markEdgeCore(edgeId, core).catch(handleError),

    // ─── Bulk ───
    bulkCreateEntities: (...args: Parameters<EngramEditor['bulkCreateEntities']>) =>
      editor.bulkCreateEntities(...args),

    bulkCreateEdges: (...args: Parameters<EngramEditor['bulkCreateEdges']>) =>
      editor.bulkCreateEdges(...args),

    bulkMarkEdgesCore: (...args: Parameters<EngramEditor['bulkMarkEdgesCore']>) =>
      editor.bulkMarkEdgesCore(...args),

    // ─── Vectorization (C4 single entry point) ───
    vectorize: (): Promise<{ vectorized: number }> =>
      editor.vectorizePending(),

    // ─── Analytics (I2) ───
    getCoverageStats: (): CoverageStats =>
      editor.getCoverageStats(),
  };
}
