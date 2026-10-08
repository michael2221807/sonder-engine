/**
 * useNpcEditor — CRUD composable for NPC relationship entries.
 *
 * Wraps: useGameState().setValue() on 社交.関係 array
 * Why: Centralizes NPC save/delete with cascade (location NPC lists,
 *      relationship network references, Engram coordination).
 *
 * Story 2 — Phase 1 foundation.
 */
import { injectService } from '@/ui/injection-keys';
import { useGameState } from '@/ui/composables/useGameState';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import { eventBus } from '@/engine/core/event-bus';
import type {
  EditorResult,
  NpcFormData,
  DeleteImpact,
  NpcFlag,
  LocationEntry,
} from './types';
import { emitEditorToast } from './types';

interface NpcRelation extends Record<string, unknown> {
  名称: string;
}

export interface UseNpcEditorReturn {
  save(index: number, formData: NpcFormData): EditorResult;
  delete(index: number): EditorResult;
  analyzeDeleteImpact(index: number): DeleteImpact;
  toggleFlag(index: number, flag: NpcFlag): EditorResult;
}

export function useNpcEditor(): UseNpcEditorReturn {
  const { setValue, get } = useGameState();
  const P = DEFAULT_ENGINE_PATHS;
  const F = P.npcFieldNames;

  const _engramEditor = injectService('engramEditor', null);

  function save(index: number, formData: NpcFormData): EditorResult {
    let list = [...(get<NpcRelation[]>(P.relationships) ?? [])];
    const name = formData[F.name] as string | undefined;

    if (!name || name.trim() === '') {
      return {
        ok: false,
        error: {
          code: 'FIELD_REQUIRED',
          i18nKey: 'relationship.toast.nameRequired',
          message: 'NPC name is required',
        },
      };
    }

    const trimmedName = name.trim();

    const dupIdx = list.findIndex(
      (npc, i) => i !== index && npc[F.name] === trimmedName,
    );
    if (dupIdx >= 0) {
      return {
        ok: false,
        error: {
          code: 'NPC_NAME_CONFLICT',
          i18nKey: 'relationship.validate.nameDuplicate',
          message: 'NPC name already exists',
        },
      };
    }

    const playerName = get<string>(P.playerName);
    if (playerName && trimmedName === playerName) {
      return {
        ok: false,
        error: {
          code: 'NPC_NAME_CONFLICT',
          i18nKey: 'relationship.validate.nameConflictPlayer',
          message: 'NPC name conflicts with player name',
        },
      };
    }

    const isEdit = index >= 0 && index < list.length;

    if (isEdit) {
      const oldName = list[index][F.name] as string;
      if (oldName && oldName !== trimmedName) {
        cascadeNpcRenameLocations(oldName, trimmedName);
        list = cascadeNpcRenameNetwork(list, oldName, trimmedName);
        eventBus.emit('editor:npc-renamed', { oldName, newName: trimmedName });
        if (_engramEditor) {
          _engramEditor.renameEntity(oldName, trimmedName).catch(() => {
            emitEditorToast('warning', 'relationship.toast.engramRenameFailed');
          });
        }
      }
      list[index] = { ...list[index], ...formData, [F.name]: trimmedName };
    } else {
      list.push({ ...formData, [F.name]: trimmedName } as NpcRelation);
    }

    setValue(P.relationships, list);
    emitEditorToast(
      'success',
      isEdit ? 'relationship.toast.updated' : 'relationship.toast.added',
    );
    return { ok: true };
  }

  function cascadeNpcRenameLocations(oldName: string, newName: string): void {
    const original = get<LocationEntry[]>(P.locations) ?? [];
    const locations = original.map(loc => {
      if (loc.NPC?.includes(oldName)) {
        return { ...loc, NPC: loc.NPC.map(n => (n === oldName ? newName : n)) };
      }
      return loc;
    });
    if (locations.some((loc, i) => loc !== original[i])) {
      setValue(P.locations, locations);
    }
  }

  function cascadeNpcRenameNetwork(
    list: NpcRelation[],
    oldName: string,
    newName: string,
  ): NpcRelation[] {
    return list.map(npc => {
      const network = npc[F.relationshipNetwork] as
        | Array<{ 对象: string; 关系: string; 备注?: string }>
        | undefined;
      if (network?.some(e => e.对象 === oldName)) {
        return {
          ...npc,
          [F.relationshipNetwork]: network.map(e =>
            e.对象 === oldName ? { ...e, 对象: newName } : e,
          ),
        };
      }
      return npc;
    });
  }

  function delete_(index: number): EditorResult {
    const originalList = get<NpcRelation[]>(P.relationships) ?? [];
    if (index < 0 || index >= originalList.length) {
      return {
        ok: false,
        error: {
          code: 'NPC_NOT_FOUND',
          i18nKey: 'relationship.validate.npcNotFound',
          message: 'NPC not found',
        },
      };
    }
    const name = originalList[index][F.name] as string;

    // Cascade 1: immutably remove from location NPC lists
    const locations = (get<LocationEntry[]>(P.locations) ?? []).map(loc => {
      if (loc.NPC?.includes(name)) {
        return { ...loc, NPC: loc.NPC.filter(n => n !== name) };
      }
      return loc;
    });
    const locChanged = locations.some(
      (loc, i) => loc !== (get<LocationEntry[]>(P.locations) ?? [])[i],
    );
    if (locChanged) setValue(P.locations, locations);

    // Cascade 2: remove from other NPCs' 关系網変量 back-references
    const updatedList = originalList.map(npc => {
      const network = npc[F.relationshipNetwork] as
        | Array<{ 对象: string; 关系: string; 备注?: string }>
        | undefined;
      if (network?.some(e => e.对象 === name)) {
        return {
          ...npc,
          [F.relationshipNetwork]: network.filter(e => e.对象 !== name),
        };
      }
      return npc;
    });

    eventBus.emit('editor:npc-deleted', { name });
    if (_engramEditor) {
      _engramEditor.deleteEntity(name, { cascade: true }).catch(() => {
        emitEditorToast('warning', 'relationship.toast.engramDeleteFailed');
      });
    }

    // Remove the NPC itself from the list
    const finalList = updatedList.filter((_, i) => i !== index);
    setValue(P.relationships, finalList);
    emitEditorToast('success', 'relationship.toast.deleted');
    return { ok: true };
  }

  function analyzeDeleteImpact(index: number): DeleteImpact {
    const list = get<NpcRelation[]>(P.relationships) ?? [];
    const npc = list[index];
    const name = (npc?.[F.name] as string) ?? '';
    const locations = get<LocationEntry[]>(P.locations) ?? [];
    const locationRefs = locations
      .filter(l => l.NPC?.includes(name))
      .map(l => l.名称);

    const engram = get<Record<string, unknown>>(P.engramMemory);
    const entities =
      (engram as { entities?: Array<{ name: string }> })?.entities ?? [];
    const hasEngramEntity = entities.some(e => e.name === name);

    return { npcName: name, locationRefs, hasEngramEntity };
  }

  function toggleFlag(index: number, flag: NpcFlag): EditorResult {
    const list = [...(get<NpcRelation[]>(P.relationships) ?? [])];
    if (index < 0 || index >= list.length) {
      return {
        ok: false,
        error: {
          code: 'NPC_NOT_FOUND',
          i18nKey: 'relationship.validate.npcNotFound',
          message: 'NPC not found',
        },
      };
    }
    list[index] = {
      ...list[index],
      [flag]: !list[index][flag],
    };
    setValue(P.relationships, list);
    return { ok: true };
  }

  return {
    save,
    delete: delete_,
    analyzeDeleteImpact,
    toggleFlag,
  };
}
