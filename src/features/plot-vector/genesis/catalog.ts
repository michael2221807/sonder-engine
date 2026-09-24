import type { ScriptValidationCatalog } from './script-runtime';

export const GENESIS_CATALOG: ScriptValidationCatalog = {
  channels: ['S+', 'S-', 'Y', 'J'],
  modes: ['normal', 'guarded', 'exposed'],
};
