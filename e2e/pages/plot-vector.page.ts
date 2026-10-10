import { expect, type Page } from '@playwright/test';
/** The plot-vector card table (phase 7): a badge beside the input opens a table from the bottom. */
export class PlotVectorPage {
  constructor(private page: Page) {}
  get control() { return this.page.getByTestId('plot-vector-control'); }
  get toggle() { return this.control.getByRole('switch'); }
  async toggleFeature() { await this.toggle.click(); }
  get boardOpen() { return this.page.getByTestId('vector-board-open'); }
  get board() { return this.page.getByTestId('vector-board'); }
  get hand() { return this.board.getByTestId('vector-hand'); }
  handCard(id: string) { return this.hand.locator(`[data-card="${id}"]`); }
  get handIds() { return this.hand.locator('.vtable__card:not([data-testid="vector-forming"])'); }
  cell(cell: string) { return this.board.locator(`.vcell[data-cell="${cell}"]`); }
  cellCard(cell: string) { return this.cell(cell).locator('.vcard'); }
  get fixedStatusCell() { return this.cell('06'); }
  /** Environment cards: no cell, they act once at each departure, shown like weather. */
  get weather() { return this.board.getByTestId('vector-weather'); }
  get boardClear() { return this.page.getByTestId('vector-clear'); }
  get replay() { return this.page.getByTestId('vector-replay'); }
  get shapeLine() { return this.page.getByTestId('vector-shape-line'); }
  get shapeRing() { return this.page.getByTestId('vector-shape-ring'); }
  get note() { return this.page.getByTestId('vector-board-note'); }
  get detail() { return this.page.getByTestId('vector-card-detail'); }
  get nativeInput() { return this.page.getByTestId('vector-native'); }
  /** The "?" panel's starting force: four gauges, then the steps when exact numbers are on. */
  get startGauges() { return this.page.getByTestId('vector-start').locator('.vhelp__gauge'); }
  get ledger() { return this.page.getByTestId('vector-ledger'); }
  /** The ribbon that plays a round's trip when the round starts (PO 2026-10-01). */
  get opening() { return this.page.getByTestId('vector-opening'); }
  marks(id: string) { return this.handCard(id).getByTestId('vector-card-marks'); }
  /** A hint (the shared Tooltip) showing now. */
  tooltip(text: string | RegExp) { return this.page.getByRole('tooltip').filter({ hasText: text }); }
  get impulse() { return this.page.getByTestId('vector-impulse'); }
  /**
   * The board as the live game holds it (what the next round uses), read from the app's state store. A kept move
   * shows here at once and stays, unlike the handle's light, which lasts 0.9 s and a busy run can miss (P6).
   */
  async liveBoard(): Promise<{ shape?: string; converter?: { from?: string; to?: string }; layout?: { placements?: Record<string, string | null> } } | null> {
    return this.page.evaluate(() => {
      type App = { config: { globalProperties: { $pinia: { _s: Map<string, { tree: Record<string, unknown> }> } } } };
      const app = (document.querySelector('#app') as { __vue_app__?: App } | null)?.__vue_app__;
      const tree = app?.config.globalProperties.$pinia._s.get('engineState')?.tree as { 系统?: { 扩展?: { plotVector?: unknown } } } | undefined;
      return JSON.parse(JSON.stringify(tree?.系统?.扩展?.plotVector ?? null));
    });
  }
  /** Waits until the live game keeps what `check` expects. */
  async kept(check: (board: Awaited<ReturnType<PlotVectorPage['liveBoard']>>) => boolean) {
    await expect.poll(async () => check(await this.liveBoard()), { timeout: 10_000 }).toBe(true);
  }
  /** Starts watching the table's handle for its "kept" light before an action, so a later check cannot miss it. */
  async watchHandleLight() {
    await this.page.evaluate(() => {
      const w = window as unknown as { __handleLit?: boolean; __handleWatch?: MutationObserver };
      w.__handleLit = false;
      w.__handleWatch?.disconnect();
      const handle = document.querySelector('.vtable__handle');
      if (!handle) return;
      w.__handleWatch = new MutationObserver(() => { if (handle.classList.contains('vtable__handle--saved')) w.__handleLit = true; });
      w.__handleWatch.observe(handle, { attributes: true, attributeFilter: ['class'] });
    });
  }
  /** The handle lit at least once since `watchHandleLight`. */
  async handleLit() {
    await expect.poll(() => this.page.evaluate(() => (window as unknown as { __handleLit?: boolean }).__handleLit === true), { timeout: 10_000 }).toBe(true);
  }
  async openBoard() {
    await this.boardOpen.click();
    await this.board.locator('.vtrack').waitFor({ state: 'visible' });
  }
  /** Tap a card, then a cell: the phone gesture, and the plainest path for a test. */
  async place(id: string, cell: string) {
    await this.handCard(id).click();
    await this.cell(cell).click();
  }
  /** Drag a hand card onto a cell with the mouse. */
  async drag(id: string, cell: string) {
    const from = await this.handCard(id).boundingBox(), to = await this.cell(cell).boundingBox();
    if (!from || !to) throw new Error('card or cell not on screen');
    await this.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await this.page.mouse.down();
    await this.page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 - 20, { steps: 3 });
    await this.page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    await this.page.mouse.up();
  }
  /** A tap on a placed card takes it back into the hand. */
  async takeOff(cell: string) { await this.cellCard(cell).click(); }
  /** Turn on exact numbers in the "?" panel (and close the panel). */
  async showExact() {
    await this.page.getByTestId('vector-help-toggle').click();
    await this.page.getByTestId('vector-exact-toggle').click();
  }
  async hoverDetail(locator: ReturnType<Page['locator']>) {
    await locator.hover();
    await this.detail.waitFor({ state: 'visible' });
  }
  /** Close the table (Esc closes an open detail or panel first, so move away from the cards). */
  async closeBoard() {
    await this.page.mouse.move(5, 5);
    await this.page.getByTestId('vector-board-close').click();
    await this.board.waitFor({ state: 'detached' });
  }
  async switchToEnglishAndResume() {
    await this.page.locator('.setting-row').filter({ hasText: '界面显示语言' }).getByRole('combobox').click();
    await this.page.getByRole('option', { name: 'English', exact: true }).click();
    // The product deliberately reloads on a language change and returns home.
    await this.page.getByRole('button', { name: 'Continue Game', exact: true }).click();
    await this.page.getByTestId('mode-toggle').waitFor({ state: 'visible' });
  }
}
