// Line icons for weather conditions (HA's condition names) and calendar markers.
// Stroke-only so they take the current text color.
import type { JSX } from "preact";
const s = { fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" } as const;

const sun = (cx = 12, cy = 12, r = 4) => (
  <g>
    <circle cx={cx} cy={cy} r={r} />
    {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
      const rad = (a * Math.PI) / 180, r1 = r + 2.5, r2 = r + 4.5;
      return <line x1={cx + r1 * Math.cos(rad)} y1={cy + r1 * Math.sin(rad)} x2={cx + r2 * Math.cos(rad)} y2={cy + r2 * Math.sin(rad)} />;
    })}
  </g>
);
const cloud = (dx = 0, dy = 0) => (
  <path transform={`translate(${dx} ${dy})`} d="M7 18h10a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 7 9.5 4.25 4.25 0 0 0 7 18z" />
);
const moon = <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />;
const drops = (n: number) => (
  <g>{Array.from({ length: n }, (_, i) => <line x1={8 + i * 4} y1={20} x2={7 + i * 4} y2={22.5} />)}</g>
);

const WEATHER: Record<string, JSX.Element> = {
  sunny: sun(),
  "clear-night": moon,
  partlycloudy: <g>{sun(9, 8, 3)}{cloud(2, 2)}</g>,
  cloudy: <g>{cloud(-1, -2)}</g>,
  fog: <g>{cloud(0, -4)}<line x1="4" y1="18" x2="20" y2="18" /><line x1="6" y1="21" x2="18" y2="21" /></g>,
  rainy: <g>{cloud(0, -3)}{drops(3)}</g>,
  pouring: <g>{cloud(0, -3)}{drops(4)}</g>,
  snowy: <g>{cloud(0, -3)}<circle cx="9" cy="21" r=".6" /><circle cx="13" cy="21" r=".6" /><circle cx="17" cy="21" r=".6" /></g>,
  "snowy-rainy": <g>{cloud(0, -3)}<line x1="9" y1="20" x2="8" y2="22.5" /><circle cx="13" cy="21" r=".6" /><line x1="17" y1="20" x2="16" y2="22.5" /></g>,
  hail: <g>{cloud(0, -3)}<circle cx="9" cy="21" r="1" /><circle cx="15" cy="21" r="1" /></g>,
  lightning: <g>{cloud(0, -3)}<path d="M12 15l-2 4h4l-2 4" /></g>,
  "lightning-rainy": <g>{cloud(0, -3)}<path d="M13 15l-2 4h4l-2 4" />{drops(1)}</g>,
  windy: <g><path d="M3 9h11a3 3 0 1 0-3-3" /><path d="M3 14h15a3 3 0 1 1-3 3" /></g>,
  "windy-variant": <g>{cloud(0, -5)}<path d="M3 19h13a2.5 2.5 0 1 1-2.5 2.5" /></g>,
  exceptional: <g><circle cx="12" cy="12" r="9" /><line x1="12" y1="7" x2="12" y2="13" /><circle cx="12" cy="16.5" r=".6" /></g>,
};

export function WeatherIcon({ condition, size }: { condition: string; size: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} {...s}>{WEATHER[condition] ?? WEATHER.cloudy}</svg>;
}

const MARKERS: Record<string, JSX.Element> = {
  flag: <g><line x1="5" y1="3" x2="5" y2="21" /><path d="M5 4h12l-2.5 4L17 12H5" /></g>,
  star: <g><path d="M12 3l7.8 13.5H4.2z" /><path d="M12 21L4.2 7.5h15.6z" /></g>,
  hockey: <g><path d="M7 3l5 14h6a2 2 0 0 1 0 4h-7.5L4 4" /><ellipse cx="17" cy="11" rx="2.2" ry="1.1" /></g>,
};

export function Marker({ name, size }: { name: string; size: number }) {
  const m = MARKERS[name];
  return m ? <svg viewBox="0 0 24 24" width={size} height={size} {...s} class="marker">{m}</svg> : null;
}
