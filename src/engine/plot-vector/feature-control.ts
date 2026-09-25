/** Global opt-in. No story data is deleted when disabled. */
export const PLOT_VECTOR_CONTROL_KEY = 'aga_plot_vector_control';
export const PLOT_VECTOR_CONTROL_EVENT = 'aga:plot-vector-control';
/** Release gate: terminateable Workers are not yet a reviewed production sandbox. */
export const plotVectorAvailable = import.meta.env.DEV;
export type StateSettlementMode = 'inline' | 'separate';
export interface PlotVectorControl { enabled: boolean; epoch: string; settlement: StateSettlementMode }
export function readPlotVectorControl(): PlotVectorControl {
  try {
    const value = JSON.parse(localStorage.getItem(PLOT_VECTOR_CONTROL_KEY) ?? 'null');
    return { enabled: plotVectorAvailable && value?.enabled === true, epoch: typeof value?.epoch === 'string' ? value.epoch : 'off',
      settlement: value?.settlement === 'separate' ? 'separate' : 'inline' };
  } catch { return { enabled: false, epoch: 'off', settlement: 'inline' }; }
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
function writeControl(enabled: boolean, settlement: StateSettlementMode): void {
  localStorage.setItem(PLOT_VECTOR_CONTROL_KEY, JSON.stringify({ enabled, settlement, epoch: randomId() }));
  window.dispatchEvent(new Event(PLOT_VECTOR_CONTROL_EVENT));
}
export function writePlotVectorControl(enabled: boolean): void {
  if (enabled && !plotVectorAvailable) throw new Error('Plot vector is available in local previews only');
  writeControl(enabled, readPlotVectorControl().settlement);
}
/** Experimental split-gen source selector; every change invalidates in-flight requests. */
export function writePlotVectorSettlementMode(settlement: StateSettlementMode): void {
  if (!plotVectorAvailable) throw new Error('Plot vector is available in local previews only');
  if (settlement !== 'inline' && settlement !== 'separate') throw new Error('Invalid settlement mode');
  writeControl(readPlotVectorControl().enabled, settlement);
}
export function subscribePlotVectorControl(listener: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === PLOT_VECTOR_CONTROL_KEY || event.key === null) listener(); };
  window.addEventListener(PLOT_VECTOR_CONTROL_EVENT, listener);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(PLOT_VECTOR_CONTROL_EVENT, listener); window.removeEventListener('storage', storage); };
}
