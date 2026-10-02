/** Global opt-in. No story data is deleted when disabled. */
export const PLOT_VECTOR_CONTROL_KEY = 'aga_plot_vector_control';
export const PLOT_VECTOR_CONTROL_EVENT = 'aga:plot-vector-control';
/** Values of VITE_PLOT_VECTOR_RELEASE that keep the feature open, in any case; unset is open too. */
const RELEASE_ON = ['', 'on', 'true', '1', 'yes'];
/**
 * Whether a build made with this VITE_PLOT_VECTOR_RELEASE value offers plot momentum. Any other value closes it:
 * someone closing it in a hurry may write 'OFF', 'false' or 'disabled', and a word nobody expected is read as that.
 */
export function releaseOpen(value: string | undefined): boolean {
  return RELEASE_ON.includes(String(value ?? '').trim().toLowerCase());
}
/**
 * Release gate (P5, docs/design/plot-vector-rebuild-plan.md §13.3): the in-page card code passed its security
 * acceptance, so the feature is available in every build — still off until the player turns it on in settings.
 * A build made with VITE_PLOT_VECTOR_RELEASE=off (or any value but on/true/1/yes) keeps it closed.
 */
export const plotVectorAvailable = releaseOpen(import.meta.env.VITE_PLOT_VECTOR_RELEASE);
export interface PlotVectorControl { enabled: boolean; epoch: string }
export function readPlotVectorControl(): PlotVectorControl {
  try {
    const value = JSON.parse(localStorage.getItem(PLOT_VECTOR_CONTROL_KEY) ?? 'null');
    return { enabled: plotVectorAvailable && value?.enabled === true, epoch: typeof value?.epoch === 'string' ? value.epoch : 'off' };
  } catch { return { enabled: false, epoch: 'off' }; }
}
/**
 * 128 random bits as an identifier (epochs, request owners, Worker job ids, CSP nonces).
 * LAN HTTP pages may expose getRandomValues without the secure-context randomUUID API;
 * there is no weaker fallback: without getRandomValues this throws.
 */
export function randomId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function writePlotVectorControl(enabled: boolean): void {
  if (enabled && !plotVectorAvailable) throw new Error('Narrative momentum is not available in this build');
  localStorage.setItem(PLOT_VECTOR_CONTROL_KEY, JSON.stringify({ enabled, epoch: randomId() }));
  window.dispatchEvent(new Event(PLOT_VECTOR_CONTROL_EVENT));
}
export function subscribePlotVectorControl(listener: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === PLOT_VECTOR_CONTROL_KEY || event.key === null) listener(); };
  window.addEventListener(PLOT_VECTOR_CONTROL_EVENT, listener);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(PLOT_VECTOR_CONTROL_EVENT, listener); window.removeEventListener('storage', storage); };
}
