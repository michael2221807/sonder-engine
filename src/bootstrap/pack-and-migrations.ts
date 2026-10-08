import { setBootstrapGamePack } from '../engine/bootstrap-pack';
import { GamePackLoader } from '../engine/core/pack-loader';
import type { CustomPresetStore } from '../engine/persistence/custom-preset-store';
import { migrationRegistry } from '../engine/persistence/migration-registry';
import type { SaveManager } from '../engine/persistence/save-manager';
import type { GamePack } from '../engine/types';
import { i18n } from '../ui/i18n';

/** Moved verbatim out of main.ts bootstrap() (R5 step 5). Statement order inside is behavior. */
export async function loadPackAndMigrations(deps: {
  saveManager: SaveManager;
  customPresetStore: CustomPresetStore;
}): Promise<GamePack | null> {
  const { saveManager, customPresetStore } = deps;
  const packLoader = new GamePackLoader();
  let pack: GamePack | null = null;
  try {
    pack = await packLoader.load('tianming', i18n.global.locale.value);
    setBootstrapGamePack(pack);
  } catch (err) {
    console.warn('[Bootstrap] Game Pack load failed:', err);
    setBootstrapGamePack(null);
  }

  // §5.2 GAP fix：把当前 pack 版本传给 SaveManager，启用 schema 迁移链
  if (pack?.manifest.version) {
    saveManager.setCurrentPackVersion(pack.manifest.version);
  }

  // Register save migrations (built-in + custom presets merged for name→description lookup)
  if (pack) {
    type P = { name: string; description?: string };
    const toP = (entries: Record<string, unknown>[]): P[] =>
      entries
        .filter((e) => typeof e['name'] === 'string')
        .map((e) => ({ name: e['name'] as string, description: typeof e['description'] === 'string' ? e['description'] : undefined }));
    const merge = (builtIn: unknown[], custom: Record<string, unknown>[]): P[] => [
      ...toP(builtIn as Record<string, unknown>[]),
      ...toP(custom),
    ];
    const [customOrigins, customTraits, customTalents] = await Promise.all([
      customPresetStore.get(pack.manifest.id, 'origins'),
      customPresetStore.get(pack.manifest.id, 'traits'),
      customPresetStore.get(pack.manifest.id, 'talents'),
    ]);
    const { createBackfillIdentityDescriptionsMigration } = await import(
      '@/engine/persistence/migrations/backfill-identity-descriptions'
    );
    migrationRegistry.register(
      createBackfillIdentityDescriptionsMigration(
        merge(pack.presets['origins'] ?? [], customOrigins),
        merge(pack.presets['traits'] ?? [], customTraits),
        merge(pack.presets['talents'] ?? [], customTalents),
      ),
    );
  }

  return pack;
}
