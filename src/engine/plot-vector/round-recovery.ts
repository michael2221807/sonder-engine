/** In-memory, single-use permission to regenerate an uncommitted round. Never stored in the save. */
export class RoundRecovery {
  private failed?: { token: string; input: string; scope: string; baseline: string; attempt?: string };
  constructor(private id: () => string) {}
  offer(input: string, scope: string, baseline: unknown, attempt?: string): string {
    const token = this.id();
    this.failed = { token, input, scope, baseline: JSON.stringify(baseline), attempt };
    return token;
  }
  begin(input: string, scope: string, baseline: unknown, token?: string): { input: string; attempt?: string } {
    const previous = this.failed;
    const matches = previous?.scope === scope && previous.baseline === JSON.stringify(baseline);
    if (token && (!matches || previous?.token !== token)) throw new Error('存档或回合已改变，请从当前输入继续');
    this.failed = undefined;
    if (token && previous) return { input: previous.input, attempt: this.id() };
    return { input, attempt: matches && previous?.input === input ? previous.attempt : undefined };
  }
}
