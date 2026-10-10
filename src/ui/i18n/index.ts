import { createI18n } from 'vue-i18n';
import zhCN from './locales/zh-CN/index';

type MessageSchema = typeof zhCN;

export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;
export type SupportedLocale = typeof SUPPORTED_LOCALES[number];

export const DEFAULT_LOCALE: SupportedLocale = 'zh-CN';

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

function getPersistedLocale(): SupportedLocale {
  try {
    const raw = localStorage.getItem('aga_user_settings');
    if (raw) {
      const parsed = JSON.parse(raw) as { language?: string };
      if (typeof parsed.language === 'string' && isSupportedLocale(parsed.language)) {
        return parsed.language;
      }
    }
  } catch { /* fallback */ }
  return DEFAULT_LOCALE;
}

const messages: { [locale: string]: MessageSchema } = {
  'zh-CN': zhCN,
};

export const i18n = createI18n({
  legacy: false,
  locale: getPersistedLocale(),
  fallbackLocale: DEFAULT_LOCALE,
  messages,
  missingWarn: import.meta.env.DEV,
  fallbackWarn: import.meta.env.DEV,
});

export async function loadLocaleMessages(locale: string): Promise<void> {
  if (locale === DEFAULT_LOCALE) return;
  if (!isSupportedLocale(locale)) return;
  if (i18n.global.availableLocales.includes(locale)) return;

  const mod = await import(`./locales/${locale}/index.ts`) as { default: MessageSchema };
  i18n.global.setLocaleMessage(locale, mod.default);
}

export async function setI18nLocale(locale: string): Promise<void> {
  if (!isSupportedLocale(locale)) return;
  await loadLocaleMessages(locale);
  i18n.global.locale.value = locale;
}
