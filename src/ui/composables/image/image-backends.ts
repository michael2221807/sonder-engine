/**
 * Image-panel helpers shared by ImagePanel and CharacterDetailsPanel (R3 step 6):
 * which image backends are configured, the Civitai LoRA snapshot reader, and
 * "copy a cached image into the reference library". Moved out of the two
 * panels; behaviour is unchanged, toast keys stay with the callers.
 */
import type { APIAssignment, APIConfig } from '@/engine/ai/types';
import type { ImageService } from '@/engine/image/image-service';
import type { CivitaiLoraSnapshot, ImageAsset, ReferenceLibraryEntry } from '@/engine/image/types';
import { generateReferenceId } from '@/engine/image/utils';

/**
 * Backends (among `keys`) that have an enabled image-category API config
 * assigned via `imageGen_<backend>`. When none do, falls back to the legacy
 * single `imageGeneration` assignment and uses that config's persisted
 * `backend` field. Insertion order follows `keys`.
 */
export function listConfiguredImageBackends(
  configs: readonly APIConfig[],
  assignments: readonly APIAssignment[],
  keys: readonly string[],
): Set<string> {
  const isEnabledImageConfig = (c: APIConfig, apiId: string) =>
    c.id === apiId && c.enabled && (c.apiCategory ?? 'llm') === 'image';
  const set = new Set<string>();
  for (const bk of keys) {
    const assignment = assignments.find((a) => a.type === `imageGen_${bk}`);
    if (!assignment || assignment.apiId === 'default') continue;
    const cfg = configs.find((c) => isEnabledImageConfig(c, assignment.apiId));
    if (cfg) set.add(bk);
  }
  if (set.size === 0) {
    const legacyAssign = assignments.find((a) => a.type === 'imageGeneration');
    if (legacyAssign && legacyAssign.apiId !== 'default') {
      const cfg = configs.find((c) => isEnabledImageConfig(c, legacyAssign.apiId));
      // Epic P0: the persisted backend field replaces URL sniffing (backfilled
      // by the store's load-time migration; 'custom' has no per-backend route).
      const b = cfg?.backend;
      if (b && keys.includes(b)) set.add(b);
    }
  }
  return set;
}

/** The Civitai LoRA snapshot stored in a history record's `providerMeta.civitai`, if well-formed. */
export function extractLoraSnapshot(record: Record<string, unknown>): CivitaiLoraSnapshot | undefined {
  const meta = record.providerMeta;
  if (!meta || typeof meta !== 'object') return undefined;
  const snap = (meta as Record<string, unknown>).civitai;
  if (!snap || typeof snap !== 'object' || !Array.isArray((snap as CivitaiLoraSnapshot).loras)) return undefined;
  return snap as CivitaiLoraSnapshot;
}

/**
 * Copy a cached image into a fresh `origin: 'reference'` asset and add it to the
 * reference library. Returns `'missing'` when the source asset is not cached;
 * storage failures throw (the caller shows its own toast).
 */
export async function copyAssetToReferenceLibrary(
  imageService: ImageService,
  assetId: string,
  entryInfo: { name: string; source: ReferenceLibraryEntry['source'] },
): Promise<'missing' | 'ok'> {
  const entry = await imageService.getAssetCache().retrieve(assetId);
  if (!entry) return 'missing';
  const refAssetId = `ref_copy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const refAsset: ImageAsset = {
    id: refAssetId, taskId: '', storageKey: refAssetId,
    mimeType: entry.metadata.mimeType, width: entry.metadata.width, height: entry.metadata.height,
    sizeBytes: entry.metadata.sizeBytes, backend: entry.metadata.backend, createdAt: Date.now(), origin: 'reference',
  };
  await imageService.getAssetCache().store(refAsset, entry.blob);
  imageService.state.addReferenceEntry({
    id: generateReferenceId(),
    assetId: refAssetId,
    name: entryInfo.name,
    mimeType: entry.metadata.mimeType,
    width: entry.metadata.width,
    height: entry.metadata.height,
    sizeBytes: entry.metadata.sizeBytes,
    source: entryInfo.source,
    createdAt: Date.now(),
  });
  return 'ok';
}
