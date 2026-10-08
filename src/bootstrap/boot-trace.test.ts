import 'fake-indexeddb/auto';
/**
 * Boot-order lock (refactor R5, step 0, light version).
 *
 * `src/main.ts` is imported for real (all ~100 engine modules real, IndexedDB faked, the tianming pack read from
 * disk) and its `bootstrap()` runs to `engine:initialized`. Three variants are recorded: `with-pack`, `no-pack`
 * (pack load rejects) and `locale-fail` (locale messages fail to load). What is stored in
 * `__snapshots__/boot-trace/<variant>.json` is the order of the things a restructure of main.ts could swap:
 *
 *  - registrations: BehaviorRunner modules, the image / TTS / STT provider registries, the config registry, the
 *    migration registry, PromptRegistry.registerPack;
 *  - the AIService setters / connection testers, SaveManager.setCurrentPackVersion, CommandExecutor.observeBatches,
 *    ImageService.setTransformerDefaults;
 *  - every `eventBus.on` event name and every emitted event name, in order;
 *  - `app.use`, `app.provide` (key + what was provided, instances numbered `#Class#n`) and `app.mount`;
 *  - the `watch` calls and the idle-callback request of the supply-rating warm-up;
 *  - the Pinia store creation order and the final behavior module id list.
 *
 * It does NOT wrap the ~100 constructors: the construction order inside bootstrap() is proved by the color-moved
 * diff of each later step plus this trace plus the e2e suite. `console.error` must never be called.
 *
 * Never rewritten with `-u` during the refactor; a changed snapshot is a failed step.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadPackFromDisk } from '../engine/__test-utils__/load-pack-from-disk';
import { createMockLocalStorage } from '../engine/__test-utils__/local-storage.mock';

const shared = vi.hoisted(() => ({
  log: [] as unknown[][],
  localeFails: false,
  /** instance → '#Class#n', numbered by first sight within a variant */
  ids: new WeakMap<object, string>(),
  counters: new Map<string, number>(),
  piniaInstance: null as null | { _s: Map<string, unknown> },
  behaviorRunners: [] as Array<{ getModules(): ReadonlyArray<{ id: string }> }>,
  initialized: null as null | (() => void),
  failed: null as null | ((e: unknown) => void),
}));

function describeValue(value: unknown): unknown {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'function') return '<fn>';
  if (typeof value === 'symbol') return String(value);
  if (typeof value !== 'object') return value;
  const obj = value as object;
  const name = obj.constructor?.name ?? 'Object';
  if (Array.isArray(value)) return `Array(${value.length})`;
  // Big plain objects (the pack, its prompt table) are only counted as objects: their content is not boot order.
  if (name === 'Object') return Object.keys(obj).length > 6 ? '{big object}' : `{${Object.keys(obj).join(',')}}`;
  let id = shared.ids.get(obj);
  if (!id) {
    const n = (shared.counters.get(name) ?? 0) + 1;
    shared.counters.set(name, n);
    id = `#${name}#${n}`;
    shared.ids.set(obj, id);
  }
  return id;
}

function L(...entry: unknown[]): void { shared.log.push(entry); }

// ── what main.ts must not need: the UI shell, the router and i18n are recording stubs ──

vi.mock('../App.vue', () => ({ default: { name: 'App' } }));

vi.mock('../ui/router', () => ({
  router: { install: () => { shared.log.push(['router.install']); }, __plugin: 'router' },
}));

vi.mock('../ui/i18n', async () => {
  const { ref } = await import('vue');
  return {
    i18n: { global: { locale: ref('zh-CN') }, install: () => { shared.log.push(['i18n.install']); }, __plugin: 'i18n' },
    loadLocaleMessages: async (locale: string) => {
      shared.log.push(['loadLocaleMessages', locale]);
      if (shared.localeFails) throw new Error('locale down');
    },
  };
});

// Only `createApp` and `watch` are replaced; the rest of Vue is the real one.
vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>();
  const realWatch = actual.watch;
  return {
    ...actual,
    createApp: (root: unknown) => {
      shared.log.push(['createApp', describeValue(root)]);
      const app = {
        config: { globalProperties: {} as Record<string, unknown> },
        use(plugin: { install?: (a: unknown) => void; __plugin?: string; _s?: Map<string, unknown> }) {
          const name = plugin.__plugin ?? (plugin._s ? 'pinia' : 'unknown');
          shared.log.push(['app.use', name]);
          if (name === 'pinia') shared.piniaInstance = plugin as unknown as { _s: Map<string, unknown> };
          plugin.install?.(app);
          return app;
        },
        provide(key: unknown, value: unknown) {
          shared.log.push(['app.provide', typeof key === 'symbol' ? String(key) : key, describeValue(value)]);
          return app;
        },
        mount(target: unknown) { shared.log.push(['app.mount', target]); },
      };
      return app;
    },
    watch: ((source: unknown, cb: unknown, options?: Record<string, unknown>) => {
      shared.log.push(['watch', options ? { ...options } : '<no options>']);
      return (realWatch as (...a: unknown[]) => unknown)(source, cb, options);
    }) as typeof actual.watch,
  };
});

const SNAPSHOT_DIR = '__snapshots__/boot-trace';
const NOW = new Date('2026-10-08T00:00:00.000Z');
const ls = createMockLocalStorage();

/** Wraps `proto[method]` so each call is logged as [label, method, ...described args], then runs the original. */
function trace(proto: object, label: string, methods: string[]): void {
  for (const method of methods) {
    const original = (proto as Record<string, unknown>)[method] as (...a: unknown[]) => unknown;
    vi.spyOn(proto as Record<string, (...a: unknown[]) => unknown>, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
      L('call', `${label}.${method}`, ...args.map(describeArg));
      return original.apply(this, args);
    });
  }
}

/** A short, stable description of an argument: strings/numbers as is, behavior modules and migrations by id. */
function describeArg(arg: unknown): unknown {
  if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
    const o = arg as { id?: unknown; version?: unknown };
    const base = describeValue(arg);
    if (typeof o.id === 'string') return `${String(base)} id=${o.id}${o.version !== undefined ? ` v=${String(o.version)}` : ''}`;
  }
  return describeValue(arg);
}

async function runBoot(variant: 'with-pack' | 'no-pack' | 'locale-fail'): Promise<void> {
  vi.resetModules();
  shared.log.length = 0;
  shared.ids = new WeakMap();
  shared.counters = new Map();
  shared.piniaInstance = null;
  shared.behaviorRunners = [];
  shared.localeFails = variant === 'locale-fail';

  const pack = variant === 'no-pack' ? null : await loadPackFromDisk();

  const { GamePackLoader } = await import('../engine/core/pack-loader');
  vi.spyOn(GamePackLoader.prototype, 'load').mockImplementation(async (packId: string) => {
    L('call', 'GamePackLoader.load', packId);
    if (!pack) throw new Error('pack down');
    return pack;
  });

  const { eventBus } = await import('../engine/core/event-bus');
  const realOn = eventBus.on.bind(eventBus);
  vi.spyOn(eventBus, 'on').mockImplementation(((event: string, handler: never) => {
    L('eventBus.on', event);
    return realOn(event as never, handler);
  }) as typeof eventBus.on);
  const realEmit = eventBus.emit.bind(eventBus);
  vi.spyOn(eventBus, 'emit').mockImplementation((event, payload) => {
    L('eventBus.emit', event);
    if (event === 'engine:initialized') shared.initialized?.();
    realEmit(event, payload);
  });

  // Keeps the runner instance so the final module id list can be read.
  const { BehaviorRunner } = await import('../engine/behaviors/behavior-runner');
  const originalRegister = BehaviorRunner.prototype.register;
  vi.spyOn(BehaviorRunner.prototype, 'register').mockImplementation(function (this: InstanceType<typeof BehaviorRunner>, module) {
    if (!shared.behaviorRunners.includes(this)) shared.behaviorRunners.push(this);
    L('call', 'BehaviorRunner.register', describeArg(module));
    return originalRegister.call(this, module);
  });

  const { ImageProviderRegistry } = await import('../engine/image/provider-registry');
  const { TtsProviderRegistry } = await import('../engine/tts/provider-registry');
  const { SttProviderRegistry } = await import('../engine/stt/provider-registry');
  const { ConfigRegistry } = await import('../engine/core/config-system');
  const { migrationRegistry } = await import('../engine/persistence/migration-registry');
  const { PromptRegistry } = await import('../engine/prompt/prompt-registry');
  const { AIService } = await import('../engine/ai/ai-service');
  const { SaveManager } = await import('../engine/persistence/save-manager');
  const { CommandExecutor } = await import('../engine/core/command-executor');
  const { ImageService } = await import('../engine/image/image-service');
  trace(ImageProviderRegistry.prototype, 'ImageProviderRegistry', ['register']);
  trace(TtsProviderRegistry.prototype, 'TtsProviderRegistry', ['register']);
  trace(SttProviderRegistry.prototype, 'SttProviderRegistry', ['register']);
  trace(ConfigRegistry.prototype, 'ConfigRegistry', ['register']);
  trace(migrationRegistry as unknown as object, 'migrationRegistry', ['register']);
  trace(PromptRegistry.prototype, 'PromptRegistry', ['registerPack']);
  trace(AIService.prototype, 'AIService', Object.getOwnPropertyNames(AIService.prototype)
    .filter((n) => /^(set|register|configure)/.test(n) && typeof (AIService.prototype as unknown as Record<string, unknown>)[n] === 'function'));
  trace(SaveManager.prototype, 'SaveManager', ['setCurrentPackVersion']);
  trace(CommandExecutor.prototype, 'CommandExecutor', ['observeBatches']);
  trace(ImageService.prototype, 'ImageService', ['setTransformerDefaults']);

  const initialized = new Promise<void>((resolve, reject) => { shared.initialized = resolve; shared.failed = reject; });
  await import('../main');
  await initialized;
  // The supply warm-up and the first store watchers settle on the microtask / macrotask queue.
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function finalDoc(): Record<string, unknown> {
  return {
    log: shared.log,
    stores: shared.piniaInstance ? [...shared.piniaInstance._s.keys()] : '<no pinia>',
    behaviorModules: shared.behaviorRunners.map((r) => r.getModules().map((m) => m.id)),
  };
}

let errorCalls: unknown[][] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(Math, 'random').mockReturnValue(0.123456);
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => '00000000-0000-4000-8000-000000000001' as `${string}-${string}-${string}-${string}-${string}`,
  );
  ls.install();
  shared.log.length = 0;
  errorCalls = [];
  // The few browser globals bootstrap touches: a recording window (listener names only).
  (globalThis as Record<string, unknown>).window = {
    addEventListener: (type: string) => { L('window.addEventListener', type); },
    removeEventListener: (type: string) => { L('window.removeEventListener', type); },
    dispatchEvent: () => true,
  };
  // The supply-rating warm-up asks for idle time; the request is recorded and never run (no stray timers).
  (globalThis as Record<string, unknown>).requestIdleCallback = (_cb: unknown, opts?: unknown) => {
    L('requestIdleCallback', describeValue(opts));
    return 0;
  };
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errorCalls.push(args);
    shared.failed?.(new Error(`console.error during boot: ${args.map((a) => (a instanceof Error ? `${a.message}
${a.stack ?? ''}` : String(a))).join(' ')}`));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    L('console.warn', ...args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `<Error: ${a.message}>` : String(a))));
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  ls.restore();
  delete (globalThis as Record<string, unknown>).requestIdleCallback;
  delete (globalThis as Record<string, unknown>).window;
  shared.initialized = null;
  shared.failed = null;
});

describe('boot trace · main.ts bootstrap order', () => {
  for (const variant of ['with-pack', 'no-pack', 'locale-fail'] as const) {
    it(`${variant}: registrations, listeners, provides and store creation happen in the locked order`, async () => {
      await runBoot(variant);
      expect(errorCalls).toEqual([]);
      const text = JSON.stringify(finalDoc(), (_k, v: unknown) => (v === undefined ? '__undefined__' : v), 2) + '\n';
      await expect(text).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${variant}.json`);
    }, 30_000);
  }
});
