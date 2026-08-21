import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockLocalStorage } from '@/engine/__test-utils__/local-storage.mock';
import { getDeviceId, describeDevice, getDeviceStamp } from './device-identity';

describe('device-identity', () => {
  let mock: ReturnType<typeof createMockLocalStorage>;
  beforeEach(() => {
    mock = createMockLocalStorage();
    mock.install();
  });
  afterEach(() => {
    mock.restore();
  });

  describe('getDeviceId', () => {
    it('generates a dev_-prefixed 8-hex id and persists it', () => {
      const id = getDeviceId();
      expect(id).toMatch(/^dev_[0-9a-f]{8}$/);
      expect(localStorage.getItem('aga_device_id')).toBe(id);
    });

    it('is stable across calls (same device → same id)', () => {
      expect(getDeviceId()).toBe(getDeviceId());
    });

    it('honors a pre-existing stored id', () => {
      localStorage.setItem('aga_device_id', 'dev_cafebabe');
      expect(getDeviceId()).toBe('dev_cafebabe');
    });
  });

  describe('describeDevice', () => {
    it('maps Windows Chrome', () => {
      expect(describeDevice(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      )).toBe('Windows · Chrome');
    });

    it('maps Windows Edge (UA also contains Chrome — Edge must win)', () => {
      expect(describeDevice(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      )).toBe('Windows · Edge');
    });

    it('maps Android Chrome', () => {
      expect(describeDevice(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      )).toBe('Android · Chrome');
    });

    it('maps iPhone Safari', () => {
      expect(describeDevice(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      )).toBe('iPhone · Safari');
    });

    it('maps macOS Firefox', () => {
      expect(describeDevice(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
      )).toBe('macOS · Firefox');
    });

    it('falls back to unknown for an empty UA', () => {
      expect(describeDevice('')).toBe('unknown');
    });
  });

  describe('getDeviceStamp', () => {
    it('returns id + label together', () => {
      const stamp = getDeviceStamp();
      expect(stamp.deviceId).toMatch(/^dev_[0-9a-f]{8}$/);
      expect(typeof stamp.deviceLabel).toBe('string');
      expect(stamp.deviceLabel.length).toBeGreaterThan(0);
    });
  });
});
