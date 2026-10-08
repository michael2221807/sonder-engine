/**
 * Artist / style preset CRUD, JSON import-export and PNG-metadata import for the presets tab (R7 step 2). Moved verbatim out of ImagePanel; the panel calls it where the block used to sit.
 */
import { type Ref, ref, computed } from 'vue';
import type { ImageBackendType, ArtistPreset } from '@/engine/image/types';
import { resolveStyleParams } from '@/engine/image/style-param-resolver';
import { eventBus } from '@/engine/core/event-bus';
import type { PanelTranslate, GetState, SetState } from './panel-deps';

export interface UseArtistPresetsDeps {
  get: GetState;
  setValue: SetState;
  t: PanelTranslate;
  backend: Readonly<Ref<ImageBackendType>>;
  configuredModelFor: (backend: ImageBackendType) => string | undefined;
  openUnderstandingForFile: (file: File) => Promise<void>;
}

export function useArtistPresets(deps: UseArtistPresetsDeps) {
  const { get, setValue, t, backend, configuredModelFor, openUnderstandingForFile } = deps;

  // Preset management state
  const presetScope = ref<'npc' | 'scene'>('npc');
  const selectedPresetId = ref('');
  const newPresetName = ref('');
  const newPresetPositive = ref('');
  const newPresetNegative = ref('');
  const newPresetArtist = ref('');

  // ArtistPreset type imported from '@/engine/image/types' (promoted from UI-local in Phase 1)

  const artistPresets = computed<ArtistPreset[]>(() => {
    const raw = get('系统.扩展.image.artistPresets');
    return Array.isArray(raw) ? raw as ArtistPreset[] : [];
  });


  // Split presets: PNG presets vs artist-only presets
  const pngPresets = computed(() =>
    artistPresets.value.filter((p) => (p.id.startsWith('png_') || p.id.startsWith('img_')))
  );
  const artistOnlyPresets = computed(() =>
    artistPresets.value.filter((p) => p.scope === presetScope.value && !(p.id.startsWith('png_') || p.id.startsWith('img_')))
  );

  // Always NPC-scoped presets (for Manual + Secret sections, independent of Presets tab scope)
  const npcArtistPresets = computed(() =>
    artistPresets.value.filter((p) => p.scope === 'npc' && !(p.id.startsWith('png_') || p.id.startsWith('img_')))
  );

  const selectedPreset = computed(() =>
    artistPresets.value.find((p) => p.id === selectedPresetId.value) ?? null
  );

  const selectedPresetParamPreview = computed(() => {
    const p = selectedPreset.value;
    if (!p) return null;
    const bk = (backend.value as import('@/engine/image/types').ImageBackendType) || 'novelai';
    return resolveStyleParams(p, bk, configuredModelFor(bk));
  });

  function createPreset() {
    const name = newPresetName.value.trim() || t('image.preset.defaultName', { id: Date.now() });
    const preset: ArtistPreset = {
      id: `preset_${Date.now()}`,
      name,
      scope: presetScope.value,
      artistString: '',
      positive: '',
      negative: '',
    };
    const list = [...artistPresets.value, preset];
    setValue('系统.扩展.image.artistPresets', list);
    selectedPresetId.value = preset.id;
    newPresetName.value = '';
  }

  function savePreset() {
    if (!selectedPreset.value) return;
    const updatedName = newPresetName.value.trim() || selectedPreset.value.name;
    const list = artistPresets.value.map((p) =>
      p.id === selectedPresetId.value
        ? { ...p, name: updatedName, positive: newPresetPositive.value, negative: newPresetNegative.value, artistString: newPresetArtist.value }
        : p
    );
    setValue('系统.扩展.image.artistPresets', list);
  }

  function deletePreset() {
    const list = artistPresets.value.filter((p) => p.id !== selectedPresetId.value);
    setValue('系统.扩展.image.artistPresets', list);
    selectedPresetId.value = '';
  }

  // Artist preset import/export (§2.7-A)
  function exportArtistPresets() {
    const data = artistPresets.value.filter((p) => p.scope === presetScope.value);
    if (data.length === 0) {
      eventBus.emit('ui:toast', { type: 'info', message: t('image.toast.noPresetsToExport'), duration: 1500 });
      return;
    }
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `artist-presets-${presetScope.value}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.presetsExported', { n: data.length }), duration: 1500 });
  }

  function importArtistPresets(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        const items: ArtistPreset[] = (Array.isArray(parsed) ? parsed : [parsed])
          .filter((p: unknown): p is ArtistPreset =>
            typeof p === 'object' && p !== null && 'name' in p
          )
          .map((p: ArtistPreset) => ({
            ...p,
            id: `import_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            scope: p.scope === 'scene' ? 'scene' : 'npc',
          }));
        if (items.length === 0) {
          eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.noValidPresetData'), duration: 2000 });
          return;
        }
        const list = [...artistPresets.value, ...items];
        setValue('系统.扩展.image.artistPresets', list);
        eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.presetsImported', { n: items.length }), duration: 1500 });
      } catch {
        eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.importFailedInvalidJson'), duration: 2000 });
      }
      input.value = '';
    };
    reader.readAsText(file);
  }

  // Load selected preset content into editor
  // PNG import
  const pngImporting = ref(false);
  const pngImportStatus = ref('');

  async function importPng(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    pngImporting.value = true;
    pngImportStatus.value = t('image.png.parsing', { name: file.name });

    try {
      const { extractPngMetadata } = await import('@/engine/image/png-metadata');
      const metadata = await extractPngMetadata(file);

      if (!metadata.positive && !metadata.rawText) {
        pngImportStatus.value = t('image.png.noMetadata');
        pngImporting.value = false;
        void openUnderstandingForFile(file);
        return;
      }

      // Generate small cover thumbnail (80x56)
      let coverDataUrl: string | undefined;
      try {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('load'));
          img.src = objectUrl;
        });
        const canvas = document.createElement('canvas');
        canvas.width = 80;
        canvas.height = 56;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, 80, 56);
          coverDataUrl = canvas.toDataURL('image/jpeg', 0.6);
        }
        URL.revokeObjectURL(objectUrl);
      } catch { /* cover is optional */ }

      const parsedParams: Record<string, unknown> = {};
      if (metadata.params?.sampler) parsedParams.sampler = metadata.params.sampler;
      if (metadata.params?.steps) parsedParams.steps = metadata.params.steps;
      if (metadata.params?.cfgScale) parsedParams.cfgScale = metadata.params.cfgScale;
      if (metadata.params?.seed) parsedParams.seed = metadata.params.seed;
      if (metadata.params?.model) parsedParams.model = metadata.params.model;
      if (metadata.params?.width) parsedParams.width = metadata.params.width;
      if (metadata.params?.height) parsedParams.height = metadata.params.height;

      const preset: ArtistPreset = {
        id: `png_${Date.now()}`,
        name: file.name.replace(/\.png$/i, ''),
        scope: presetScope.value,
        artistString: '',
        positive: metadata.positive ?? '',
        negative: metadata.negative ?? '',
        pngMeta: {
          source: metadata.source,
          originalPrompt: metadata.positive ?? '',
          rawText: metadata.rawText ?? '',
          parsedParams: Object.keys(parsedParams).length > 0 ? parsedParams : undefined,
          replicateParams: false,
          coverDataUrl,
        },
      };

      const list = [...artistPresets.value, preset];
      setValue('系统.扩展.image.artistPresets', list);
      selectedPresetId.value = preset.id;
      loadPresetIntoEditor();
      pngImportStatus.value = t('image.png.imported', { name: preset.name });
    } catch (err) {
      pngImportStatus.value = t('image.png.parseFailed', { error: (err as Error).message });
    } finally {
      pngImporting.value = false;
      input.value = '';
    }
  }

  function loadPresetIntoEditor() {
    if (selectedPreset.value) {
      newPresetName.value = selectedPreset.value.name;
      newPresetPositive.value = selectedPreset.value.positive;
      newPresetNegative.value = selectedPreset.value.negative;
      newPresetArtist.value = selectedPreset.value.artistString;
    }
  }

  function toggleReplicateParams(value: boolean) {
    if (!selectedPreset.value?.pngMeta) return;
    const list = artistPresets.value.map((p) =>
      p.id === selectedPresetId.value
        ? { ...p, pngMeta: { ...p.pngMeta!, replicateParams: value } }
        : p
    );
    setValue('系统.扩展.image.artistPresets', list);
  }

  return {
    presetScope,
    selectedPresetId,
    newPresetName,
    newPresetPositive,
    newPresetNegative,
    newPresetArtist,
    artistPresets,
    pngPresets,
    artistOnlyPresets,
    npcArtistPresets,
    selectedPreset,
    selectedPresetParamPreview,
    createPreset,
    savePreset,
    deletePreset,
    exportArtistPresets,
    importArtistPresets,
    pngImporting,
    pngImportStatus,
    importPng,
    loadPresetIntoEditor,
    toggleReplicateParams,
  };
}
