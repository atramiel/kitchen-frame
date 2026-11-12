// Server-side Home Assistant reads for Ambient mode. The HA token stays on the
// Mac; the page only sees the shaped /api/ambient payload.
import { readFileSync } from "node:fs";
import { join } from "node:path";

type CalendarCfg = { entity: string; color: string; icon?: string };

export function createHa(root: string, haUrl: string) {
  const token = readFileSync(join(root, "secrets", "ha.env"), "utf8").match(/^HA_TOKEN=(.+)$/m)?.[1].trim();
  if (!token) throw new Error("HA_TOKEN missing from secrets/ha.env");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  async function get(path: string) {
    const res = await fetch(haUrl + path, { headers });
    if (!res.ok) throw new Error(`HA GET ${path}: ${res.status}`);
    return res.json();
  }
  async function post(path: string, body: unknown) {
    const res = await fetch(haUrl + path, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HA POST ${path}: ${res.status}`);
    return res.json();
  }

  // Midnight today in the Mac's local zone (same zone as HA: America/Los_Angeles).
  function dayStart(offsetDays = 0) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offsetDays);
    return d;
  }

  async function events(calendars: CalendarCfg[], days: number) {
    const start = dayStart().toISOString(), end = dayStart(days).toISOString();
    const lists = await Promise.all(calendars.map(async (c) => {
      try {
        const evs = await get(`/api/calendars/${c.entity}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
        return evs.map((e: any) => ({
          title: e.summary as string,
          allDay: !!e.start.date,
          start: e.start.dateTime ?? e.start.date,
          end: e.end.dateTime ?? e.end.date,
          calendar: c.entity, color: c.color, icon: c.icon,
        }));
      } catch (err) {
        console.error(`calendar ${c.entity}:`, (err as Error).message);
        return [];
      }
    }));
    return lists.flat();
  }

  // Temperatures recorded since local midnight. The forecast's "today" only covers
  // the rest of the day, so by evening its high is just the current temperature.
  async function todaysRange(entity: string) {
    try {
      const rows = (await get(`/api/history/period/${encodeURIComponent(dayStart().toISOString())}`
        + `?filter_entity_id=${entity}&significant_changes_only=0`))[0] ?? [];
      const temps = rows.map((r: any) => r.attributes?.temperature).filter((t: unknown) => typeof t === "number");
      return temps.length ? { high: Math.max(...temps), low: Math.min(...temps) } : undefined;
    } catch { return undefined; }
  }

  type Day = { date: string; condition: string; high: number; low: number | null; precip: number | null };

  // Daily forecast. met.no gives one entry per day; NWS only gives day/night
  // periods ("twice_daily"), which are folded into one entry per date: the day
  // period sets the high and condition, the following night the low.
  async function dailyForecast(entity: string): Promise<Day[]> {
    const supported = (await get(`/api/states/${entity}`)).attributes.supported_features as number;
    const type = supported & 1 ? "daily" : "twice_daily"; // WeatherEntityFeature: 1 daily, 2 hourly, 4 twice_daily
    const fc = (await post(`/api/services/weather/get_forecasts?return_response`, { entity_id: entity, type }))
      .service_response[entity].forecast as any[];
    if (type === "daily") {
      return fc.map((d) => ({ date: d.datetime, condition: d.condition, high: d.temperature, low: d.templow ?? null, precip: d.precipitation_probability ?? null }));
    }
    const byDate = new Map<string, Day>();
    for (const p of fc) {
      const date = new Date(p.datetime).toDateString();
      const d = byDate.get(date) ?? { date: p.datetime, condition: p.condition, high: p.temperature, low: null, precip: null };
      if (p.is_daytime) { d.high = p.temperature; d.condition = p.condition; }
      else d.low = p.temperature;
      d.precip = Math.max(d.precip ?? 0, p.precipitation_probability ?? 0);
      byDate.set(date, d);
    }
    // Just after midnight NWS still lists last night's period, dated yesterday.
    return [...byDate.values()].filter((d) => new Date(d.date) >= dayStart() || new Date(d.date).toDateString() === new Date().toDateString());
  }

  // Today's measured high/low straight from an NWS station (°F). Better than HA
  // history: these are real readings, and they cover the whole day from midnight.
  let stationCache: { at: number; day: string; range?: { high: number; low: number } } | undefined;
  async function stationRange(station: string) {
    // The station reports every 20 minutes; no need to ask NWS more than every 10.
    const day = new Date().toDateString();
    if (stationCache && stationCache.day === day && Date.now() - stationCache.at < 10 * 60_000) return stationCache.range;
    const range = await fetchStationRange(station);
    stationCache = { at: Date.now(), day, range };
    return range;
  }
  async function fetchStationRange(station: string) {
    try {
      const res = await fetch(`https://api.weather.gov/stations/${station}/observations?start=${dayStart().toISOString()}`,
        { headers: { "user-agent": "kitchen-frame", accept: "application/geo+json" } });
      if (!res.ok) return undefined;
      const temps = ((await res.json()).features as any[])
        .map((f) => f.properties.temperature.value).filter((c): c is number => typeof c === "number")
        .map((c) => c * 9 / 5 + 32);
      return temps.length ? { high: Math.round(Math.max(...temps)), low: Math.round(Math.min(...temps)) } : undefined;
    } catch { return undefined; }
  }

  async function weather(entity: string, station?: string) {
    const [state, daily, range] = await Promise.all([
      get(`/api/states/${entity}`),
      dailyForecast(entity),
      station ? stationRange(station).then((r) => r ?? todaysRange(entity)) : todaysRange(entity),
    ]);
    const a = state.attributes;
    const today = daily[0];
    if (today && range && new Date(today.date).toDateString() === new Date().toDateString()) {
      today.high = Math.max(today.high, range.high);
      today.low = Math.min(today.low ?? range.low, range.low);
    }
    return {
      condition: state.state as string,
      temperature: a.temperature as number,
      feelsLike: a.apparent_temperature ?? feelsLike(a.temperature, a.humidity, a.wind_speed),
      unit: a.temperature_unit as string,
      daily,
    };
  }

  async function state(entity: string) {
    const s = await get(`/api/states/${entity}`);
    return { state: s.state as string, attributes: s.attributes, since: s.last_changed as string };
  }

  async function call(domain: string, service: string, data: Record<string, unknown>) {
    return post(`/api/services/${domain}/${service}`, data);
  }

  return { events, weather, state, call };
}

// NWS wind chill (≤50°F, wind >3 mph) and heat index (≥80°F); otherwise the air temperature.
function feelsLike(t: number, rh?: number, windMph?: number) {
  if (t <= 50 && windMph && windMph > 3) {
    const v = Math.pow(windMph, 0.16);
    return Math.round(35.74 + 0.6215 * t - 35.75 * v + 0.4275 * t * v);
  }
  if (t >= 80 && rh != null) {
    const hi = -42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh - 0.00683783 * t * t
      - 0.05481717 * rh * rh + 0.00122874 * t * t * rh + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;
    return Math.round(hi);
  }
  return Math.round(t);
}

// US EPA AQI from PM2.5 (µg/m³), 2024 breakpoints.
export function pm25ToAqi(pm: number) {
  const bp: [number, number, number, number][] = [
    [0, 9.0, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150],
    [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 500],
  ];
  const c = Math.floor(pm * 10) / 10;
  const [cl, ch, il, ih] = bp.find(([, hi]) => c <= hi) ?? bp[bp.length - 1];
  return Math.round(((ih - il) / (ch - cl)) * (c - cl) + il);
}
