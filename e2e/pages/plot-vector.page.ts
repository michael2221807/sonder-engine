import type { Page } from '@playwright/test';
export class PlotVectorPage {
  constructor(private page: Page) {}
  get control() { return this.page.getByTestId('plot-vector-control'); }
  get toggle() { return this.control.getByRole('switch'); }
  async toggleFeature() { await this.toggle.click(); }
  get recovery() { return this.page.getByTestId('plot-vector-recovery'); }
  async openRecovery() { await this.recovery.locator('summary').click(); }
  get clearRecords() { return this.recovery.getByRole('button', {name: '清空本机恢复记录', exact: true}); }
  async acknowledgeClear() { await this.recovery.getByRole('checkbox').check(); }
  get boardOpen() { return this.page.getByTestId('vector-board-open'); }
  get board() { return this.page.getByTestId('vector-board'); }
  get boardSave() { return this.page.getByTestId('vector-save'); }
  get boardPreview() { return this.page.getByTestId('vector-preview'); }
  get replay() { return this.board.getByRole('slider'); }
  get fixedStatusCell() { return this.board.locator('[data-cell="06"]'); }
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
