/**
 * Harden the realm that runs card code (the product child Worker). Two steps, in order:
 *
 * 1. Cut the dynamic-code links. Every function object inherits `constructor` from one of four
 *    dynamic-function prototypes (Function, AsyncFunction, GeneratorFunction,
 *    AsyncGeneratorFunction). `ctx.rng['constr' + 'uctor']`, or the same through a generator
 *    method, would otherwise hand card code a constructor whose sloppy-mode functions see
 *    `globalThis`. Those `constructor` links are replaced by a thrower. The global `Function`
 *    binding that the runtime compiles hooks with stays usable; card code cannot name it (hook
 *    scope, see `HOOK_SCOPE_ALLOWLIST`) and no longer reaches it through any object.
 * 2. Freeze every object reachable from the realm's standard intrinsics (named and anonymous):
 *    prototypes, own data values and accessor functions. That covers whatever a hook can reach
 *    through its allowlisted names, its own literals and the `ctx` values it is handed.
 *
 * Deliberately not walked: `globalThis`, host objects such as `crypto`, the message channel.
 * The hook scope never resolves those names and step 1 removes the only object path to them.
 *
 * Self-contained (no imports, no module-scope helpers) so tests can run the bundled Worker
 * source in a separate `node:vm` realm without freezing the test process' own intrinsics.
 */
export function hardenIntrinsics(realm: object = globalThis): { frozen: number; failed: string[] } {
  const source = realm as Record<string, unknown>;
  const failed: string[] = [];
  const RealmFunction = source.Function as FunctionConstructor;
  const named = [
    'Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol', 'BigInt', 'Math', 'JSON', 'Reflect',
    'Date', 'RegExp', 'Promise', 'Proxy', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry',
    'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
    'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'Intl',
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
    'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
    'parseInt', 'parseFloat', 'isFinite', 'isNaN', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
    'escape', 'unescape', 'eval', 'structuredClone', 'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  ];
  const roots: unknown[] = named.map(name => source[name]);
  const tryPush = (make: () => unknown) => { try { roots.push(make()); } catch { /* absent in this realm */ } };
  // Anonymous intrinsics, reachable only through instances.
  tryPush(() => Object.getPrototypeOf([][Symbol.iterator]()));
  tryPush(() => Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())));
  tryPush(() => Object.getPrototypeOf(new Map()[Symbol.iterator]()));
  tryPush(() => Object.getPrototypeOf(new Set()[Symbol.iterator]()));
  tryPush(() => Object.getPrototypeOf(''[Symbol.iterator]()));
  tryPush(() => Object.getPrototypeOf(/x/[Symbol.matchAll]('')));
  tryPush(() => Object.getPrototypeOf(Object.getPrototypeOf(new Uint8Array(0))).constructor);
  tryPush(() => Object.getOwnPropertyDescriptor(Function.prototype, 'caller')?.get);

  // Step 1: the four dynamic-function constructors and their prototypes' `constructor` link.
  const constructors: unknown[] = [RealmFunction];
  for (const body of ['return async function () {}', 'return function* () {}', 'return async function* () {}']) {
    try { constructors.push(Object.getPrototypeOf(new RealmFunction(body)()).constructor); } catch { /* syntax absent */ }
  }
  tryPush(() => Object.getPrototypeOf(new RealmFunction('return function* () {}')()()));
  tryPush(() => Object.getPrototypeOf(new RealmFunction('return async function* () {}')()()));
  const tamed = function (): never { throw new TypeError('dynamic code is not available to abilities'); };
  for (const ctor of constructors) {
    if (typeof ctor !== 'function') continue;
    roots.push(ctor);
    const proto: unknown = (ctor as { prototype?: unknown }).prototype;
    if ((typeof proto !== 'object' && typeof proto !== 'function') || proto === null) continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'constructor');
    if (!descriptor || descriptor.value !== ctor) continue;
    try { Object.defineProperty(proto, 'constructor', { value: tamed, writable: false, enumerable: false, configurable: false }); }
    catch (error) { failed.push(String(error)); }
  }
  roots.push(tamed);

  // Step 2: freeze the closure of everything reachable from the roots.
  const seen = new Set<object>();
  const stack: object[] = [];
  const push = (value: unknown) => {
    if ((typeof value === 'object' && value !== null) || typeof value === 'function') stack.push(value as object);
  };
  roots.forEach(push);
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    try { Object.freeze(node); } catch (error) { failed.push(String(error)); }
    push(Object.getPrototypeOf(node));
    let keys: (string | symbol)[] = [];
    try { keys = Reflect.ownKeys(node); } catch (error) { failed.push(String(error)); }
    for (const key of keys) {
      let descriptor: PropertyDescriptor | undefined;
      try { descriptor = Object.getOwnPropertyDescriptor(node, key); } catch { continue; }
      if (!descriptor) continue;
      push(descriptor.value); push(descriptor.get); push(descriptor.set);
    }
  }
  return { frozen: seen.size, failed };
}
