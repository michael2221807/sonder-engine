import { describe, expect, it } from 'vitest';
import { lanUploadSizeKb } from './lan-sync';

describe('lanUploadSizeKb', () => {
  it('rounds the byte size to whole kilobytes (half rounds up), exactly as Math.round(size / 1024)', () => {
    for (const size of [0, 1, 511, 512, 513, 1024, 1536, 1537, 10_485_760, 123_456_789]) {
      expect(lanUploadSizeKb(size)).toBe(Math.round(size / 1024));
    }
    expect(lanUploadSizeKb(512)).toBe(1);
    expect(lanUploadSizeKb(511)).toBe(0);
  });
});
