/**
 * CreationView page object — the character-creation wizard.
 * Locators + actions only; the step-walking order lives in the spec (deterministic).
 * Name field testid is tianming-pack-specific (角色.基础信息.姓名), matching the seed.
 */
import type { Page, Locator } from '@playwright/test';

export class CreationPage {
  constructor(private readonly page: Page) {}

  get progressBar(): Locator { return this.page.locator('.progress-bar'); }
  get presetCards(): Locator { return this.page.locator('.preset-card'); }
  get nextButton(): Locator { return this.page.getByTestId('creation-next'); }
  get startButton(): Locator { return this.page.getByTestId('creation-start'); }
  get budgetSummary(): Locator { return this.page.getByTestId('creation-budget-summary'); }
  get enhancedOpeningFailureTitle(): Locator { return this.page.getByRole('heading', { name: '增强开局失败' }); }

  /** Select the first preset card on a select-one step. */
  async selectFirstPreset(): Promise<void> { await this.presetCards.first().click(); }

  /** Select a preset by its visible canonical name. */
  async selectPreset(name: string): Promise<void> {
    await this.presetCards.filter({ hasText: name }).click();
  }

  async addCustomChoice(input: {
    stepLabel: string;
    name: string;
    description: string;
    cost: number;
    genre: string;
    adultOnly?: boolean;
  }): Promise<void> {
    await this.page.getByRole('button', { name: `+ 自定义${input.stepLabel}` }).click();
    await this.page.locator('#fld-name').fill(input.name);
    await this.page.locator('#fld-description').fill(input.description);
    await this.page.locator('#fld-talent_cost').fill(String(input.cost));
    await this.page.locator('#fld-genres').selectOption(input.genre);
    if (input.adultOnly) await this.page.locator('#fld-adultOnly').check();
    await this.page.getByRole('button', { name: '保存', exact: true }).click();
  }

  async next(): Promise<void> { await this.nextButton.click(); }

  /** Evenly distribute attribute points — one click fills the whole budget. */
  async balanceAttributes(): Promise<void> { await this.page.getByTestId('creation-attr-balance').click(); }

  /** Fill the tianming character-name field (the only required identity field). */
  async fillName(name: string): Promise<void> {
    await this.page.getByTestId('creation-field-角色.基础信息.姓名').fill(name);
  }

  /** Toggle the enhanced-opening switch (default ON → one click turns it OFF). */
  async toggleEnhancedOpening(): Promise<void> { await this.page.getByTestId('creation-enhanced-toggle').click(); }

  async exitEnhancedOpening(): Promise<void> { await this.page.getByRole('button', { name: '退出增强开局' }).click(); }

  async start(): Promise<void> { await this.startButton.click(); }
}
