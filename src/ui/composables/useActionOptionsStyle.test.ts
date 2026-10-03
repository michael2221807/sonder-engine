import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';

// The device storage and the loaded game, both in memory.
const stored = new Map<string, string>();
const written: Array<[string, unknown]> = [];
const loaded = ref(true);
vi.stubGlobal('localStorage', {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => { stored.set(k, v); },
});
vi.mock('./useGameState', () => ({
  useGameState: () => ({ isLoaded: loaded, setValue: (path: string, value: unknown) => { written.push([path, value]); } }),
}));

const { useActionOptionsStyle, normalizeActionOptionsStyle, readActionOptionsStyle, ACTION_OPTIONS_STYLE_KEY } =
  await import('./useActionOptionsStyle');

beforeEach(() => {
  stored.clear();
  written.length = 0;
  loaded.value = true;
  useActionOptionsStyle().refresh();
});

// PO 2026-10-03: both settings pages edit the one style the round reads.
describe('useActionOptionsStyle', () => {
  it('reads unknown values as the defaults, from storage, a settings file or a card', () => {
    expect(normalizeActionOptionsStyle({ mode: 'story', pace: 'slow', customPrompt: 'x' })).toEqual({ mode: 'story', pace: 'slow', customPrompt: 'x' });
    expect(normalizeActionOptionsStyle({ mode: 'Story', pace: 1, customPrompt: null })).toEqual({ mode: 'action', pace: 'fast', customPrompt: '' });
    expect(normalizeActionOptionsStyle('nonsense')).toEqual({ mode: 'action', pace: 'fast', customPrompt: '' });
    stored.set(ACTION_OPTIONS_STYLE_KEY, '{broken');
    expect(readActionOptionsStyle()).toEqual({ mode: 'action', pace: 'fast', customPrompt: '' });
  });

  it('a change on one page is the other page\'s value at once, on this device and in the loaded game', () => {
    const prompt = useActionOptionsStyle(), settings = useActionOptionsStyle();
    prompt.save({ mode: 'story' });
    prompt.save({ pace: 'slow' });
    expect(settings.style.value).toEqual({ mode: 'story', pace: 'slow', customPrompt: '' });
    expect(JSON.parse(stored.get(ACTION_OPTIONS_STYLE_KEY)!)).toEqual({ mode: 'story', pace: 'slow', customPrompt: '' });
    expect(written.slice(-3)).toEqual([['系统.actionOptions.mode', 'story'], ['系统.actionOptions.pace', 'slow'], ['系统.actionOptions.customPrompt', '']]);
  });

  it('a save lands on what the device holds now, not on a copy read before a card import changed it', () => {
    const page = useActionOptionsStyle();
    // A card import writes the device's style directly, without telling the page.
    stored.set(ACTION_OPTIONS_STYLE_KEY, JSON.stringify({ mode: 'story', pace: 'fast', customPrompt: 'from the card' }));
    page.save({ pace: 'slow' });
    expect(page.style.value).toEqual({ mode: 'story', pace: 'slow', customPrompt: 'from the card' });
  });

  it('a page shown again reads the device\'s style again', () => {
    const page = useActionOptionsStyle();
    stored.set(ACTION_OPTIONS_STYLE_KEY, JSON.stringify({ mode: 'story', pace: 'slow', customPrompt: '' }));
    expect(page.style.value.mode).toBe('action');
    page.refresh();
    expect(page.style.value).toEqual({ mode: 'story', pace: 'slow', customPrompt: '' });
  });

  it('with no game loaded, a change is kept on the device only (loading a game copies it in)', () => {
    loaded.value = false;
    useActionOptionsStyle().save({ mode: 'story' });
    expect(written).toEqual([]);
    expect(JSON.parse(stored.get(ACTION_OPTIONS_STYLE_KEY)!).mode).toBe('story');
  });
});
