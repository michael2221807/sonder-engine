import type {
  AggregationResult,
  BipolarReadout,
  ChannelId,
  ChannelMeta,
  DimensionDef,
  DimensionId,
  NetVector,
  ReadoutOptions,
  TraceEvent,
  VectorPacket,
} from './types';

export const DIMENSION_SCHEMA_VERSION = 'lab-fixture-1';
export const REPRESENTATION_VERSION = 'bipolar-dual-channel-1';

export function channelsForDimension(channels: ChannelMeta[], dim: DimensionId): { plus?: ChannelId; minus?: ChannelId; mono?: ChannelId } {
  const own = channels.filter((c) => c.dimension === dim);
  if (own.length === 2) {
    return {
      plus: own.find((c) => c.pole === 'positive')?.id,
      minus: own.find((c) => c.pole === 'negative')?.id,
    };
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

export function totalMass(payload: Record<ChannelId, number>): number {
  let m = 0;
  for (const v of Object.values(payload)) m += v;
  return m;
}

export function bipolarReadout(payload: Record<ChannelId, number>, plus: ChannelId, minus: ChannelId, kappa: number): BipolarReadout {
  const p = payload[plus] ?? 0;
  const n = payload[minus] ?? 0;
  const den = p + n + kappa;
  return {
    direction: den === 0 ? 0 : (p - n) / den,
    activity: den === 0 ? 0 : (p + n) / den,
    conflict: den === 0 ? 0 : (2 * Math.min(p, n)) / den,
  };
}

/** N1 / N2 / N3 readouts over the same final payload (framework D39 / D45 / D62). */
export function readoutDimensions(
  payload: Record<ChannelId, number>,
  dims: DimensionDef[],
  channels: ChannelMeta[],
  options: ReadoutOptions,
): { dimensions: Record<DimensionId, number>; composition?: Record<ChannelId, number>; intensity?: number } {
  const net = netVector(payload, dims, channels);
  const M = totalMass(payload);
  const k = options.kappa;
  const dimensions: Record<DimensionId, number> = {};
  switch (options.kind) {
    case 'N1':
      for (const d of dims) dimensions[d.id] = Math.tanh((net[d.id] ?? 0) / k);
      return { dimensions };
    case 'N2':
      for (const d of dims) dimensions[d.id] = k + M === 0 ? 0 : (net[d.id] ?? 0) / (k + M);
      return { dimensions };
    case 'N3': {
      const intensity = k + M === 0 ? 0 : M / (k + M);
      const composition: Record<ChannelId, number> = {};
      for (const c of channels) composition[c.id] = M === 0 ? 0 : (payload[c.id] ?? 0) / M;
      // Vector part equals N2 when I = M/(κ+M) (D50); exposed separately so p and I stay visible.
      for (const d of dims) dimensions[d.id] = M === 0 ? 0 : intensity * ((net[d.id] ?? 0) / M);
      return { dimensions, composition, intensity };
    }
  }
}

export function aggregateVisits(samples: NetVector[], dims: DimensionDef[]): AggregationResult {
  const mean: NetVector = {};
  for (const d of dims) {
    let s = 0;
    for (const v of samples) s += v[d.id] ?? 0;
    mean[d.id] = samples.length ? s / samples.length : 0;
  }
  return { visitSamples: samples, visitMean: mean, visitCount: samples.length };
}

export function buildVectorPacket(
  settlementId: string,
  payload: Record<ChannelId, number>,
  dims: DimensionDef[],
  channels: ChannelMeta[],
  options: ReadoutOptions,
  trace: TraceEvent[],
  shuttleAccount: string,
  labelOf: (effectId: string) => { zh: string; en: string },
): VectorPacket {
  const r = readoutDimensions(payload, dims, channels, options);
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
    dimensions: r.dimensions,
    optionalComposition: r.composition,
    optionalIntensity: r.intensity,
    optionalConflict: Object.keys(conflict).length ? conflict : undefined,
    sourceSummary: scored,
  };
}
