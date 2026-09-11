// App doc: docs/user-guide/pages/game-main.md §3.17（回合前存档自检）
/**
 * Storage-health baseline — the save tree's own record of what its side stores held.
 *
 * Why the baseline lives INSIDE the state tree (`系统.扩展.storageHealth`): the 2026-09-09
 * incident lost two independent IndexedDB databases (image cache, world books) AND the
 * localStorage device identity, while `aga-saves` survived. Anything recorded outside
 * the save tree would have vanished with the evidence. Image references already live in
 * the tree; world books do not, so the ids of the profile books that were last seen
 * present are recorded here. The save-health check (`save-health.ts`) compares the live
 * store against this record, and the upload guard (`github-sync.ts`) refuses to push a
 * bundle whose export carries zero books while the tree says there should be some.
 *
 * Pure module: no imports beyond types, so both the engine check and BackupService can
 * use it without a dependency cycle.
 */

export interface StorageHealthBaseline {
  schemaVersion: 1;
  /** Ids of the profile world books last confirmed present in `aga-worldbook`. */
  worldBookIds: string[];
  /** Round at which the record was last written (audit only). */
  updatedRound: number;
}

/** Read a dotted path from a plain object tree without throwing. */
function readPath(tree: unknown, path: string): unknown {
  let node: unknown = tree;
  for (const key of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * The recorded world-book ids for a save tree, or an empty list when the save has never
 * been checked (older saves) or the record is malformed. Absence must read as "nothing
 * expected" — a save that predates the feature must never trip the alarm.
 */
export function readWorldBookBaseline(tree: unknown, storageHealthPath: string): string[] {
  const raw = readPath(tree, storageHealthPath);
  if (!raw || typeof raw !== 'object') return [];
  const ids = (raw as { worldBookIds?: unknown }).worldBookIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** Build the record to write back after the books were confirmed present. */
export function buildStorageHealthBaseline(worldBookIds: readonly string[], round: number): StorageHealthBaseline {
  return { schemaVersion: 1, worldBookIds: [...new Set(worldBookIds)].sort(), updatedRound: round };
}

/** True when the recorded ids differ from `ids` (order-insensitive) — avoids no-op state writes. */
export function baselineDiffers(tree: unknown, storageHealthPath: string, ids: readonly string[]): boolean {
  const current = [...new Set(readWorldBookBaseline(tree, storageHealthPath))].sort();
  const next = [...new Set(ids)].sort();
  if (current.length !== next.length) return true;
  return current.some((id, i) => id !== next[i]);
}

/** Export-side integrity of the world-book section, per the trees being exported. */
export interface WorldBookIntegrity {
  /** Sum over profiles of the books the trees say should exist (max across a profile's slots). */
  expectedBooks: number;
  /** Books actually placed in the export. */
  exportedBooks: number;
  /** Profiles whose trees expect ≥1 book but for which the export carries none. */
  degradedProfiles: string[];
}

/**
 * Compare what the exported save trees expect against what the export carries.
 *
 * `expectedByProfile` = max `worldBookIds.length` across each profile's slots (slots of
 * one profile share the same books, and an older slot may predate the record).
 * A profile counts as degraded only on TOTAL absence (expected > 0, exported 0): that is
 * the shape a lost IndexedDB store produces, while a deliberate deletion of some books
 * is a normal edit and must never block an upload.
 */
export function computeWorldBookIntegrity(
  treesByProfile: ReadonlyMap<string, readonly unknown[]>,
  exportedByProfile: ReadonlyMap<string, number>,
  storageHealthPath: string,
): WorldBookIntegrity {
  let expectedBooks = 0;
  let exportedBooks = 0;
  const degradedProfiles: string[] = [];
  const profiles = new Set([...treesByProfile.keys(), ...exportedByProfile.keys()]);
  for (const pid of profiles) {
    let expected = 0;
    for (const tree of treesByProfile.get(pid) ?? []) {
      expected = Math.max(expected, readWorldBookBaseline(tree, storageHealthPath).length);
    }
    const exported = exportedByProfile.get(pid) ?? 0;
    expectedBooks += expected;
    exportedBooks += exported;
    if (expected > 0 && exported === 0) degradedProfiles.push(pid);
  }
  return { expectedBooks, exportedBooks, degradedProfiles };
}
