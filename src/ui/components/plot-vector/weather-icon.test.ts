import { describe, expect, it } from 'vitest';
import { weatherIcon, WEATHER_PATHS } from './weather-icon';

describe('weather icons on the table', () => {
  it('reads the kind of weather from the name and description, in either language', () => {
    expect(weatherIcon('细雨', '路面湿滑')).toBe('rain');
    expect(weatherIcon('雷雨交加')).toBe('storm');
    expect(weatherIcon('深夜静谧', '四下无声')).toBe('night');
    expect(weatherIcon('大雾')).toBe('fog');
    expect(weatherIcon('寒潮')).toBe('cold');
    expect(weatherIcon('Light breeze')).toBe('wind');
    expect(weatherIcon('Clear sky')).toBe('sun');
  });
  it('a mood that is not weather wears the general mark, and every icon has a drawing', () => {
    expect(weatherIcon('条例落地', '新规开始执行')).toBe('air');
    expect(weatherIcon(undefined, '')).toBe('air');
    for (const path of Object.values(WEATHER_PATHS)) expect(path.length).toBeGreaterThan(10);
  });
});
