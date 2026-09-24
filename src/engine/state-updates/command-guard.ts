import type { Command } from '../types';
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Guard both direct model writes (including an omitted root) and relocated execution writes. */
export function compiledCommandGuard(paths: string[], approved: readonly Command[]) {
  const allowed = new Set(approved.map(stable));
  const protectedPaths = paths.flatMap(path => {
    const rootEnd = path.indexOf('.');
    return rootEnd < 0 ? [path] : [path, path.slice(rootEnd + 1)];
  });
  return (command: Command): string | undefined => {
    // Normalize bracket property access too; filters match by their collection prefix.
    const key = command.key.replace(/\[['"]?([^\[\]'"=]+)['"]?\]/g, '.$1');
    const overlaps = protectedPaths.some(p => key === p || key.startsWith(p + '.') || key.startsWith(p + '[')
      || p.startsWith(key + '.') || p.startsWith(key.split('[')[0] + '.'));
    if (overlaps && !allowed.has(stable(command))) return 'Protected state requires an approved update';
  };
}
