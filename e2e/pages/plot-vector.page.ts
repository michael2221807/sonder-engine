import type { Page } from '@playwright/test';
export class PlotVectorPage {
  constructor(private page: Page) {}
  get control() { return this.page.getByTestId('plot-vector-control'); }
  get toggle() { return this.control.getByRole('switch'); }
  async toggleFeature() { await this.toggle.click(); }
  get boardOpen() { return this.page.getByTestId('vector-board-open'); }
  get board() { return this.page.getByTestId('vector-board'); }
  get boardSave() { return this.page.getByTestId('vector-save'); }
  get boardPreview() { return this.page.getByTestId('vector-preview'); }
  get boardClear() { return this.page.getByTestId('vector-clear'); }
  get replay() { return this.board.getByRole('slider'); }
  get fixedStatusCell() { return this.board.locator('[data-cell="06"]'); }
  /** Environment cards: no cell, they act once at each departure. */
  get weather() { return this.board.getByTestId('vector-weather'); }
  get nativeInput() { return this.board.getByTestId('vector-native'); }
  get progress() { return this.board.getByTestId('vector-progress'); }
  cellChoice(cell: string) { return this.board.locator(`[data-cell="${cell}"] select`); }
  async openBoard() { await this.boardOpen.click(); }
  async showLast() { await this.board.getByRole('button', { name: '上回合结果', exact: true }).click(); }
  async chooseCard(cell: string, id: string) { await this.cellChoice(cell).selectOption(id); }
  async switchToEnglishAndResume() {
    await this.page.locator('.setting-row').filter({ hasText: '界面显示语言' }).getByRole('combobox').click();
    await this.page.getByRole('option', { name: 'English', exact: true }).click();
    // The product deliberately reloads on a language change and returns home.
    await this.page.getByRole('button', { name: 'Continue Game', exact: true }).click();
    await this.page.getByTestId('mode-toggle').waitFor({ state: 'visible' });
  }
}
