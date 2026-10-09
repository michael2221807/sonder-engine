/** SavePanel page object — export flow + full-backup + save-to-card entry points. */
import type { Page, Locator } from '@playwright/test';

export class SavePage {
  constructor(private readonly page: Page) {}

  /** Open the game-card export wizard (CardExportFlow). Always-visible CTA. */
  async openExportFlow(): Promise<void> { await this.page.locator('.card-export-cta__btn').click(); }

  /** A save slot card by slotId (the seed uses 'auto'). */
  slot(slotId: string): Locator { return this.page.getByTestId(`save-slot-${slotId}`); }

  /** The size a slot card shows (the save in play is measured when the panel opens). */
  slotSize(slotId: string): Locator { return this.slot(slotId).locator('.slot-detail--size'); }

  /** Expand the collapsible settings section that hosts the full-backup controls. */
  async openSettings(): Promise<void> { await this.page.getByTestId('save-settings-toggle').click(); }

  get backupExportButton(): Locator { return this.page.getByTestId('backup-export'); }
  get backupImportButton(): Locator { return this.page.getByTestId('backup-import'); }
  get backupAcknowledge(): Locator { return this.page.getByTestId('backup-acknowledge'); }
  get backupConfirmButton(): Locator { return this.page.getByTestId('backup-confirm'); }

  /** Open the save-to-card (转卡) wizard for a slot (the seed uses 'auto'). */
  async openToCard(slotId: string): Promise<void> { await this.page.getByTestId(`save-slot-tocard-${slotId}`).click(); }
}
