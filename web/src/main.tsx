import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { WeatherIcon, Marker } from "./icons";
import { Cameras, LiveView, useLive, setCameraConfig, type LiveConfig, type CameraConfig } from "./cameras";

// Ambient mode, laid out like the DAKboard screen it replaces: 1080x1920 CSS px
// (2160x3840 at DPR 2). Photo on top, 4-day agenda, weather strip at the bottom.
// Other modes (engaged, visitor, cameras, sleep) come in later phases.

type Event = { title: string; allDay: boolean; start: string; end: string; calendar: string; color: string; icon?: string; logo?: string };

// All-day events (holidays) and birthdays render as a single small line.
const isCompact = (e: Event) => e.allDay || /birthday/i.test(e.title);
type Ambient = {
  events: Event[];
  weather: { condition: string; temperature: number; feelsLike: number; unit: string;
    daily: { date: string; condition: string; high: number; low: number | null }[] };
  aqi: { aqi: number; pm25: number } | null;
  calendars: { days: number };
  appliances?: { name: string; icon: string; state: string; since?: string; tone: "running" | "attention" | "idle"; hidden: boolean }[];
};

const params = new URLSearchParams(location.search);
const layout = params.get("layout") === "fullbleed" ? "fullbleed" : "dakboard";

function useNow(ms: number) {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function usePoll<T>(url: string, ms: number) {
  const [data, setData] = useState<T>();
  useEffect(() => {
    let alive = true;
    const load = () => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((d) => alive && setData(d)).catch(() => {});
    load();
    const t = setInterval(load, ms);
    return () => { alive = false; clearInterval(t); };
  }, [url, ms]);
  return data;
}

// Slideshow with history: auto-advance crossfades; swiping left shows the next
// photo (new, or forward through history), swiping right goes back. The server
// picks photos, so the client keeps the last HISTORY images to step back through.
const HISTORY = 30;
type Transition = "fade" | "left" | "right";

type Shot = { url: string; taken?: Date };

// "Today" / "3 years ago · Oct 2023" / "Mar 6" for a photo's capture date.
function takenLabel(t: Date, now = new Date()) {
  const years = now.getFullYear() - t.getFullYear() - (now < new Date(now.getFullYear(), t.getMonth(), t.getDate()) ? 1 : 0);
  const sameDay = t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
  if (sameDay && years > 0) return `On this day · ${years === 1 ? "1 year" : `${years} years`} ago`;
  if (t.toDateString() === now.toDateString()) return "Today";
  const monthYear = t.toLocaleDateString([], { month: "short", year: "numeric" });
  if (years < 1) return t.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${years === 1 ? "1 year" : `${years} years`} ago · ${monthYear}`;
}

function Photos({ intervalS }: { intervalS: number }) {
  const [shown, setShown] = useState<{ cur?: Shot; prev?: Shot; anim: Transition; n: number }>({ anim: "fade", n: 0 });
  const st = useRef({ history: [] as Shot[], pos: -1, busy: false, timer: 0 });

  const display = (pos: number, anim: Transition) => {
    const s = st.current;
    const prev = s.history[s.pos];
    s.pos = pos;
    setShown((x) => ({ cur: s.history[pos], prev, anim, n: x.n + 1 }));
  };

  const fetchNew = async () => {
    const res = await fetch(`/api/photo?${layout === "fullbleed" ? "full&" : ""}${Date.now()}`);
    if (!res.ok) throw new Error(String(res.status));
    const taken = res.headers.get("x-photo-taken");
    const url = URL.createObjectURL(await res.blob());
    await new Promise((ok) => { const i = new Image(); i.onload = i.onerror = ok; i.src = url; });
    const s = st.current;
    s.history.push({ url, taken: taken ? new Date(taken) : undefined });
    if (s.history.length > HISTORY) { URL.revokeObjectURL(s.history.shift()!.url); s.pos--; }
    return s.history.length - 1;
  };

  // Keep one photo loaded ahead of the one on screen, so "next" is instant.
  const prefetching = useRef<Promise<number> | undefined>(undefined);
  const prefetch = () => {
    const s = st.current;
    if (prefetching.current || s.pos < s.history.length - 1) return;
    prefetching.current = fetchNew().catch(() => -1).finally(() => { prefetching.current = undefined; });
  };

  const step = async (dir: 1 | -1, anim: Transition) => {
    const s = st.current;
    if (s.busy) return;
    s.busy = true;
    try {
      if (dir === -1) { if (s.pos > 0) display(s.pos - 1, anim); }
      else {
        if (s.pos >= s.history.length - 1 && prefetching.current) await prefetching.current;
        display(s.pos < s.history.length - 1 ? s.pos + 1 : await fetchNew(), anim);
      }
    } catch { /* keep the current photo */ } finally { s.busy = false; prefetch(); }
  };

  const restartTimer = () => {
    clearInterval(st.current.timer);
    st.current.timer = setInterval(() => step(1, "fade"), intervalS * 1000) as unknown as number;
  };

  useEffect(() => {
    step(1, "fade");
    restartTimer();
    return () => clearInterval(st.current.timer);
  }, [intervalS]);

  const swipe = (dir: 1 | -1) => { restartTimer(); step(dir, dir === 1 ? "left" : "right"); };

  // Touch or mouse drag: at least 60 px and more sideways than vertical.
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const onDown = (e: PointerEvent) => {
    start.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as Element).setPointerCapture(e.pointerId); // still get pointerup if the finger leaves the photo
  };
  const onUp = (e: PointerEvent) => {
    const s0 = start.current;
    start.current = undefined;
    if (!s0) return;
    const dx = e.clientX - s0.x, dy = e.clientY - s0.y;
    if (Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy)) return swipe(dx < 0 ? 1 : -1);
    // A tap (barely moved): left third goes back, right third goes forward.
    // The middle is left free for later (tap to open the control panel).
    if (Math.abs(dx) < 15 && Math.abs(dy) < 15) {
      const box = (e.currentTarget as Element).getBoundingClientRect();
      const x = (e.clientX - box.left) / box.width;
      if (x < 1 / 3) { swipe(-1); flash("back"); }
      else if (x > 2 / 3) { swipe(1); flash("next"); }
    }
  };

  // Brief chevron on the tapped side, so a tap visibly registered.
  const [hint, setHint] = useState<{ side: "back" | "next"; n: number }>();
  const flash = (side: "back" | "next") => setHint((h) => ({ side, n: (h?.n ?? 0) + 1 }));

  // Trackpad two-finger swipe (desktop preview) arrives as horizontal wheel events.
  const wheel = useRef({ sum: 0, until: 0 });
  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    const w = wheel.current, now = Date.now();
    if (now < w.until) return; // one photo per gesture
    w.sum += e.deltaX;
    if (Math.abs(w.sum) > 80) { swipe(w.sum > 0 ? 1 : -1); w.sum = 0; w.until = now + 700; }
  };

  // Arrow keys, for the desktop preview.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") swipe(1);
      else if (e.key === "ArrowLeft") swipe(-1);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <div class="photos" onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => (start.current = undefined)} onWheel={onWheel}>
      {shown.prev && <div key={`p${shown.n}`} class={`photo out-${shown.anim}`} style={{ backgroundImage: `url(${shown.prev.url})` }} />}
      {shown.cur && <div key={`c${shown.n}`} class={`photo in-${shown.anim}`} style={{ backgroundImage: `url(${shown.cur.url})` }} />}
      {shown.cur?.taken && <div key={`t${shown.n}`} class="taken">{takenLabel(shown.cur.taken)}</div>}
      {hint && <div key={`h${hint.n}`} class={`tap-hint ${hint.side}`}>{hint.side === "back" ? "‹" : "›"}</div>}
    </div>
  );
}

function Clock() {
  const now = useNow(1000);
  const h = now.getHours() % 12 || 12, m = String(now.getMinutes()).padStart(2, "0"), s = String(now.getSeconds()).padStart(2, "0");
  return (
    <div class="clock">
      <div class="time">{h}:{m}<span class="sec">{s}</span></div>
      <div class="date">{now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>
    </div>
  );
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Events touching a given local day. All-day dates are YYYY-MM-DD with an exclusive end.
function eventsOn(events: Event[], day: Date) {
  const start = new Date(day), end = new Date(day);
  end.setDate(end.getDate() + 1);
  return events
    .filter((e) => {
      const s = e.allDay ? new Date(e.start + "T00:00") : new Date(e.start);
      const f = e.allDay ? new Date(e.end + "T00:00") : new Date(e.end);
      return s < end && (f > start || (+f === +s && s >= start));
    })
    // Small one-line events (all-day, birthdays) first, then by start time.
    .sort((a, b) => (isCompact(a) === isCompact(b) ? +new Date(a.start) - +new Date(b.start) : isCompact(a) ? -1 : 1));
}

function DayHeader({ day, index }: { day: Date; index: number }) {
  const label = index === 0 ? "Today" : index === 1 ? "Tomorrow" : day.toLocaleDateString([], { weekday: "long" });
  return <div class="day-head"><span class="num">{String(day.getDate()).padStart(2, "0")}</span><span class="label">{label}</span></div>;
}

// Today's timed events: over (dimmed), happening now, or starting within the hour.
const SOON_MIN = 60;
function timing(e: Event, now: Date): { cls: string; tag?: string } {
  if (e.allDay) return { cls: "" };
  const s = new Date(e.start), f = new Date(e.end);
  if (f <= now) return { cls: " past" };
  if (s <= now) return { cls: " now", tag: "Now" };
  const mins = Math.ceil((+s - +now) / 60000);
  if (mins <= SOON_MIN) return { cls: " soon", tag: `in ${mins} min` };
  return { cls: "" };
}

// A day's events, scrollable when they don't fit. The edge with more events
// beyond it fades; 30 s after the last scroll it glides back to the top.
function DayEvents({ children }: { children: preact.ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ top: false, bottom: false });
  const idle = useRef(0);
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 2, bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setFade((f) => (f.top === top && f.bottom === bottom ? f : { top, bottom }));
  };
  useEffect(measure);
  useEffect(() => () => clearTimeout(idle.current), []);
  const onScroll = () => {
    measure();
    clearTimeout(idle.current);
    idle.current = setTimeout(() => ref.current?.scrollTo({ top: 0, behavior: "smooth" }), 30_000) as unknown as number;
  };
  return (
    <div ref={ref} class={`day-events${fade.top ? " fade-top" : ""}${fade.bottom ? " fade-bottom" : ""}`} onScroll={onScroll}>
      {children}
    </div>
  );
}

function Agenda({ data }: { data: Ambient }) {
  const now = useNow(30_000);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: data.calendars.days }, (_, i) => { const d = new Date(today); d.setDate(d.getDate() + i); return d; });
  return (
    <div class="agenda" style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}>
      {days.map((day, i) => {
        const evs = eventsOn(data.events, day);
        return (
          <div class="day">
            <DayHeader day={day} index={i} />
            <DayEvents>
            {evs.map((e) => {
              const compact = isCompact(e);
              const t = timing(e, now);
              return (
                <div class={`event${compact ? " compact" : ""}${t.cls}`} style={{ "--c": e.color }}>
                  {!compact && <div class="when">{e.logo && <img class="logo" src={e.logo} alt="" />}{fmtTime(new Date(e.start))}{t.tag && <span class="tag">{t.tag}</span>}</div>}
                  <div class="title">
                    {compact && e.logo ? <img class="logo" src={e.logo} alt="" /> : !e.logo && e.icon && <Marker name={e.icon} size={compact ? 20 : 26} />}
                    {e.title}
                  </div>
                </div>
              );
            })}
            </DayEvents>
          </div>
        );
      })}
    </div>
  );
}

// EPA AQI category colors.
const aqiBand = (aqi: number) =>
  aqi <= 50 ? ["Good", "#00b050"] : aqi <= 100 ? ["Moderate", "#e6c300"] : aqi <= 150 ? ["Unhealthy for some", "#ff7e00"]
  : aqi <= 200 ? ["Unhealthy", "#e8202a"] : aqi <= 300 ? ["Very unhealthy", "#8f3f97"] : ["Hazardous", "#7e0023"];

function Weather({ data }: { data: Ambient }) {
  const w = data.weather;
  const today = new Date();
  return (
    <div class="weather">
      <div class="now">
        <div class="temp-row">
          <span class="temp">{Math.round(w.temperature)}°</span>
          <WeatherIcon condition={w.condition} size={110} />
        </div>
        <div class="now-row">
          <span class="feels">Feels like {Math.round(w.feelsLike)}</span>
          {data.aqi && (() => {
            const [label, color] = aqiBand(data.aqi.aqi);
            return <span class="aqi"><b style={{ background: color }}>{data.aqi.aqi}</b><i>{label}<small>AQI</small></i></span>;
          })()}
        </div>
      </div>
      <div class="days">
        {w.daily.slice(0, 4).map((d) => {
          const date = new Date(d.date);
          return (
            <div class="fday">
              <div class="dname">{sameDay(date, today) ? "Today" : date.toLocaleDateString([], { weekday: "short" })}</div>
              <WeatherIcon condition={d.condition} size={64} />
              <div class="hl"><span>{Math.round(d.high)}°</span><span class="lo">{d.low == null ? "–" : `${Math.round(d.low)}°`}</span></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Small outline icons for the appliance row.
const APPLIANCE_ICONS: Record<string, preact.JSX.Element> = {
  dishwasher: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 8h16M8 5.5h1M11 5.5h1" /><path d="M9 14h6" /></>,
  washer: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 7h16M7.5 5h1" /><circle cx="12" cy="14" r="4" /></>,
  dryer: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 7h16M7.5 5h1" /><circle cx="12" cy="14" r="4" /><path d="M10.5 13.2c1-.8 2-.8 3 0" /></>,
};

// "5m", "3h", "2d": how long the status has held.
function ago(since: string | undefined, now: number) {
  if (!since) return "";
  const m = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

// Dishwasher, washer and dryer, small and dim above the weather. A running
// appliance is tinted blue; one that needs emptying or moving is tinted amber.
function Appliances({ list }: { list: NonNullable<Ambient["appliances"]> }) {
  const now = useNow(30_000).getTime();
  const shown = list.filter((a) => !a.hidden);
  if (!shown.length) return null;
  return (
    <div class="appliances">
      {shown.map((a) => (
        <span class={`appliance ${a.tone}`} title={a.name}>
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            {APPLIANCE_ICONS[a.icon] ?? APPLIANCE_ICONS.washer}
          </svg>
          <span>{a.state}</span>
          <small>{ago(a.since, now)}</small>
        </span>
      ))}
    </div>
  );
}

function App() {
  const data = usePoll<Ambient>("/api/ambient", 60_000);
  const config = usePoll<{ photos: { interval_s: number }; live: LiveConfig; cameras?: CameraConfig }>("/api/config", 3_600_000);
  if (config) setCameraConfig(config.cameras ?? {});
  const live = useLive(config?.live);
  const [forceLive, setForceLive] = useState(params.get("view") === "live"); // ?view=live, for previews
  // The grid of all cameras: from "All cameras" in the live view (or ?view=cameras).
  const [cameras, setCameras] = useState(params.get("view") === "cameras");
  // Say so when the server can't be reached, so a frame that can't get camera
  // alerts doesn't look like it's working (the clock and the last photo stay up).
  const [started] = useState(Date.now());
  const offline = live.offline || (!config && Date.now() - started > 60_000);
  return (
    <main class={`ambient layout-${layout}`}>
      {offline && <div class="offline">Can't reach the frame server. Camera alerts are off.</div>}
      {cameras && <Cameras onClose={() => setCameras(false)} idleS={config?.live.manual_close_after_s ?? 120} />}
      {(live.open || forceLive) && live.cameras.length > 0 &&
        <LiveView cameras={live.cameras} moving={live.moving} onClose={() => { live.close(); setForceLive(false); }}
          onActivity={live.ping} onAll={() => { live.close(); setForceLive(false); setCameras(true); }} />}
      {config && <Photos intervalS={config.photos.interval_s} />}
      <div class="scrim" />
      <Clock />
      <button class="cam-button" onClick={live.openManual} aria-label="Cameras">
        <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2l1.5-2h8l1.5 2h2A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
          <circle cx="12" cy="13" r="3.5" />
        </svg>
      </button>
      <section class="info">
        {data ? <><Agenda data={data} />{data.appliances && <Appliances list={data.appliances} />}<Weather data={data} /></> : <div class="loading">Loading…</div>}
      </section>
    </main>
  );
}

// Scale the fixed 1080x1920 canvas to fit whatever window it's in (the Cozyla
// fits exactly; a desktop preview shrinks it).
function fit() {
  const s = Math.min(innerWidth / 1080, innerHeight / 1920);
  document.documentElement.style.setProperty("--fit", String(s));
}
addEventListener("resize", fit);
fit();
fetch(`/api/hello?${encodeURIComponent(`${innerWidth}x${innerHeight} dpr=${devicePixelRatio} fit=${Math.min(innerWidth / 1080, innerHeight / 1920).toFixed(3)} ${navigator.userAgent}`)}`).catch(() => {});

render(<App />, document.getElementById("app")!);
