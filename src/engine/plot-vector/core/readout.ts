import type { BipolarReadout, ChannelId, ChannelMeta, DimensionDef, DimensionId, LocalizedLabel, NetVector, ReadoutOptions, TraceEvent, VectorPacket } from './types';

const DIMENSION_SCHEMA_VERSION = 'lab-fixture-1';
const REPRESENTATION_VERSION = 'bipolar-dual-channel-1';

function channelsForDimension(channels: ChannelMeta[], dim: DimensionId): { plus?: ChannelId; minus?: ChannelId; mono?: ChannelId } {
  const own = channels.filter((c) => c.dimension === dim);
  if (own.length === 2) {
    return { plus: own.find((c) => c.pole === 'positive')?.id, minus: own.find((c) => c.pole === 'negative')?.id };
  }
  return { mono: own[0]?.id };
}

/** Net vector: bipolar dims = plus − minus; unipolar = the single channel. */
export function netVector(payload: Record<ChannelId, number>, dims: DimensionDef[], channels: ChannelMeta[]): NetVector {
  const out: NetVector = {};
  for (const d of dims) {
    const ch = channelsForDimension(channels, d.id);
    if (ch.mono) out[d.id] = payload[ch.mono] ?? 0;
    else out[d.id] = (payload[ch.plus ?? ''] ?? 0) - (payload[ch.minus ?? ''] ?? 0);
  }
  return out;
}

function bipolarReadout(payload: Record<ChannelId, number>, plus: ChannelId, minus: ChannelId, kappa: number): BipolarReadout {
  const p = payload[plus] ?? 0;
  const n = payload[minus] ?? 0;
  const den = p + n + kappa;
  return {
    direction: den === 0 ? 0 : (p - n) / den,
    activity: den === 0 ? 0 : (p + n) / den,
    conflict: den === 0 ? 0 : (2 * Math.min(p, n)) / den,
  };
}

/** N1 readout: each dimension is tanh(net / κ) of the final payload. */
function readoutDimensions(payload: Record<ChannelId, number>, dims: DimensionDef[], channels: ChannelMeta[], options: ReadoutOptions): Record<DimensionId, number> {
  const net = netVector(payload, dims, channels);
  const dimensions: Record<DimensionId, number> = {};
  for (const d of dims) dimensions[d.id] = Math.tanh((net[d.id] ?? 0) / options.kappa);
  return dimensions;
}

export function buildVectorPacket(
  settlementId: string,
  payload: Record<ChannelId, number>,
  dims: DimensionDef[],
  channels: ChannelMeta[],
  options: ReadoutOptions,
  trace: TraceEvent[],
  shuttleAccount: string,
  labelOf: (effectId: string) => LocalizedLabel,
): VectorPacket {
  const conflict: Record<DimensionId, BipolarReadout> = {};
  for (const d of dims) {
    const ch = channelsForDimension(channels, d.id);
    if (ch.plus && ch.minus) conflict[d.id] = bipolarReadout(payload, ch.plus, ch.minus, options.kappa);
  }
  // Source summary: effects with the largest absolute shuttle deltas.
  const scored = trace
    .filter((e) => e.eventType === 'effect' && e.status === 'applied' && e.owner && e.effectId)
    .map((e) => ({
      owner: e.owner!,
      effectId: e.effectId!,
      magnitude: e.deltas.filter((d) => d.account === shuttleAccount).reduce((s, d) => s + Math.abs(d.after - d.before), 0),
    }))
    .filter((x) => x.magnitude > 0)
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, 3)
    .map((x) => ({ ...x, label: labelOf(x.effectId) }));
  return {
    settlementId,
    dimensionSchemaVersion: DIMENSION_SCHEMA_VERSION,
    representationVersion: REPRESENTATION_VERSION,
    readoutVersion: `${options.kind}-kappa${options.kappa}`,
    dimensions: readoutDimensions(payload, dims, channels, options),
    optionalConflict: Object.keys(conflict).length ? conflict : undefined,
    sourceSummary: scored,
  };
}
