/** GameLayout shell page object — the in-game chrome (mode toggle, sidebar tabs). */
import type { Page, Locator } from '@playwright/test';
import { goToGameTab } from '../fixtures/navigation';

export class GameShellPage {
  constructor(private readonly page: Page) {}

  /** Play / write (worldBuilding) mode toggle — present on every /game/* route. */
  get modeToggle(): Locator { return this.page.getByTestId('mode-toggle'); }

  async toggleMode(): Promise<void> { await this.modeToggle.click(); }

  /** Navigate to a left-sidebar tab; pass '' for the main panel. */
  async goTab(tab: string): Promise<void> { await goToGameTab(this.page, tab); }

  /** Play-mode message composer (hidden in write mode). */
  get composer(): Locator { return this.page.locator('textarea.message-input'); }
  async send(text: string): Promise<void> { await this.composer.fill(text); await this.page.locator('button.send-btn').click(); }

  /** Write-mode in-panel notice that replaces the composer. */
  get wbNotice(): Locator { return this.page.locator('.wb-composer-notice'); }

  /** The "open the guide" button inside the write-mode notice. */
  async openGuideFromNotice(): Promise<void> { await this.page.locator('a.wb-composer-notice__btn').click(); }
}
