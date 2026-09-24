export interface RoundSlot { profileId: string; slotId: string }

/** Host ownership survives shallow context copies and does not depend on a game feature. */
export class RoundOwnership {
  saved = false;
  invalidated = false;
  private readonly slot: RoundSlot | null;
  private readonly revision: number;
  constructor(private currentSlot: () => RoundSlot | null, private currentRevision: () => number,
    private signal: AbortSignal) {
    const slot = currentSlot(); this.slot = slot ? { ...slot } : null;
    this.revision = currentRevision();
  }
  isCurrent(): boolean {
    const slot = this.currentSlot();
    if (this.revision !== this.currentRevision() || slot?.profileId !== this.slot?.profileId
      || slot?.slotId !== this.slot?.slotId) this.invalidated = true;
    return !this.invalidated;
  }
  guard(): void {
    if (!this.isCurrent()) throw new Error('存档已切换，旧回合已取消');
    if (!this.saved && this.signal.aborted) throw new Error('Pipeline aborted');
  }
}
