// Apply persisted font-size x ui-scale before any component renders so the
// user's preference survives page refresh regardless of which route they
// land on. SettingsPanel owns the source of truth; this is a cold-boot
// replay of what SettingsPanel.applyRootMetrics does.
export function applyPersistedRootMetrics(): void {
  try {
    const raw = localStorage.getItem('aga_user_settings');
    const scaleRaw = localStorage.getItem('aga_ui_scale');
    const parsed = raw ? (JSON.parse(raw) as { fontSize?: number; themeAccent?: string }) : {};
    const fontPx = typeof parsed.fontSize === 'number' ? parsed.fontSize : 14;
    const scalePct = scaleRaw ? Number(scaleRaw) : 100;
    const rootPx = (fontPx * scalePct) / 100;
    document.documentElement.style.fontSize = `${rootPx}px`;
    document.documentElement.style.setProperty('--base-font-size', `${fontPx}px`);
    document.documentElement.style.setProperty('--narrative-font-size', `${fontPx}px`);
    document.documentElement.style.setProperty('--ui-scale', `${scalePct}%`);
    if (typeof parsed.themeAccent === 'string') {
      document.documentElement.style.setProperty('--color-primary', parsed.themeAccent);
    }
  } catch { /* localStorage unavailable — skip silently */ }
}
