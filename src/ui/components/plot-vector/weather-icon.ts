/**
 * Which small icon an environment card wears on the table (phase 7 polish): read from the words of its name and
 * description, since environments carry no type. A mood that is not weather (a policy, a rumour) wears the
 * general "atmosphere" mark. Display only; nothing here decides what a card does.
 */
export type WeatherIcon = 'rain' | 'snow' | 'wind' | 'fog' | 'storm' | 'night' | 'sun' | 'cold' | 'heat' | 'air';

const WORDS: ReadonlyArray<[WeatherIcon, RegExp]> = [
  ['storm', /雷|暴雨|风暴|台风|storm|thunder|typhoon/i],
  ['rain', /雨|drizzle|rain|shower/i],
  ['snow', /雪|霜|snow|frost|sleet/i],
  ['fog', /雾|霾|烟|fog|mist|haze|smoke/i],
  ['wind', /风|wind|breeze|gust/i],
  ['night', /夜|月|深更|night|moon|midnight|dark/i],
  ['cold', /寒|冷|凉|冻|cold|chill|freez/i],
  ['heat', /热|暑|炎|燥|heat|hot|swelter/i],
  ['sun', /晴|阳|日光|sun|clear|bright/i],
];

export function weatherIcon(...texts: Array<string | undefined>): WeatherIcon {
  const text = texts.filter(Boolean).join(' ');
  return WORDS.find(([, re]) => re.test(text))?.[0] ?? 'air';
}

/** SVG path data (24×24 box, stroked) for each icon. */
export const WEATHER_PATHS: Readonly<Record<WeatherIcon, string>> = {
  rain: 'M7 15h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.2 6.1 4.5 4.5 0 0 0 7 15ZM9 18l-1 3M13 18l-1 3M17 18l-1 3',
  snow: 'M7 14h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.2 5.1 4.5 4.5 0 0 0 7 14ZM9 18h.01M12 20h.01M15 18h.01',
  wind: 'M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3M3 12h8',
  fog: 'M4 9h16M3 13h18M5 17h14',
  storm: 'M7 14h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.2 5.1 4.5 4.5 0 0 0 7 14ZM13 14l-3 4h4l-2 4',
  night: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  cold: 'M12 2v20M4 7l16 10M4 17L20 7M9 4l3 2 3-2M9 20l3-2 3 2',
  heat: 'M12 3c1 3 4 4.5 4 8.5A4 4 0 0 1 8 11.5C8 9 9.5 8 10 6c1 1.5 1 2.5 2 3 0-2-.5-4 0-6Z',
  air: 'M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.2 9.1 4.5 4.5 0 0 0 7 18Z',
};
