/**
 * Minimal FileReader stub for the node test environment.
 *
 * `ImageAssetCache` turns blobs into base64 through `FileReader.readAsDataURL` (and waits for `onloadend`), which node
 * does not have. This stub answers with the same `data:<type>;base64,<payload>` string a browser gives and fires both
 * `onload` and `onloadend`. Shared by the R6 behaviour locks so the R3 image-flow test (which carries its own copy)
 * stays untouched.
 */
import { vi } from 'vitest';

class FakeFileReader {
  result: string | ArrayBuffer | null = null;
  error: unknown = null;
  onload: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
      this.onload?.();
      this.onloadend?.();
    });
  }
}

/** Installs the stub as a vitest-managed global (undone by `vi.unstubAllGlobals()`). */
export function installFileReaderStub(): void {
  vi.stubGlobal('FileReader', FakeFileReader);
}
