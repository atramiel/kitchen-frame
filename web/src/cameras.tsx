import { useEffect, useRef, useState } from "preact/hooks";
import { chime } from "./chime";

// Camera grid (Low streams) and full-screen view (Medium). Video comes from go2rtc
// over WebRTC through frame-server's /go2rtc proxy; video only, so it's silent.
// The player is go2rtc's own VideoRTC element, loaded at runtime from go2rtc.

let playerReady: Promise<void> | undefined;
function loadPlayer() {
  playerReady ??= import(/* @vite-ignore */ `${location.origin}/go2rtc/video-rtc.js`).then(({ VideoRTC }) => {
    if (!customElements.get("frame-cam")) customElements.define("frame-cam", class extends VideoRTC {});
  });
  return playerReady;
}

// Camera settings from config.yaml `cameras`, set once the config loads:
// h264_transcode  cameras that send H.265; their H.264 copies are played instead,
//                 which the tablet's browser decodes smoothly
// doorbell        the doorbell camera (Talk, its package-camera inset)
// names / order   display names, and which cameras come first in the grid
export type CameraConfig = { h264_transcode?: string[]; doorbell?: string; names?: Record<string, string>; order?: string[] };
let cameraConfig: CameraConfig = {};
export const setCameraConfig = (c: CameraConfig) => { cameraConfig = c; };
const h264Cameras = () => cameraConfig.h264_transcode ?? [];
// Grid (Low) streams always use their always-on copies, which start instantly.
const playable = (stream: string) =>
  stream.endsWith("_low") || h264Cameras().some((c) => stream === c || stream.startsWith(c + "_")) ? `${stream}_h264` : stream;

// The doorbell camera: its audio is heard while Talk is on.
const doorbell = () => cameraConfig.doorbell ?? "";

// "driveway_ptz" → "Driveway PTZ", unless config gives it a name.
const nameOf = (id: string) => cameraConfig.names?.[id]
  ?? id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bPtz\b/, "PTZ");

// `listen` (doorbell only) also pulls the camera's audio and unmutes it when true.
function Cam({ stream, listen }: { stream: string; listen?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<any>(undefined);
  useEffect(() => {
    let el: any, alive = true;
    const src = playable(stream);
    // Copies (<stream>_h264) have no source of their own; wait until one is publishing.
    Promise.all([loadPlayer(), src.endsWith("_h264") ? untilPublished(src, () => alive) : null]).then(() => {
      if (!alive) return;
      el = document.createElement("frame-cam");
      player.current = el;
      el.mode = "webrtc,mse";
      el.media = listen === undefined ? "video" : "video,audio";
      el.visibilityThreshold = 0;
      el.background = false;
      host.current?.appendChild(el);
      // go2rtc's player turns on the browser's video controls; on a touchscreen a tap
      // then pauses the video. Taps should reach the tile instead.
      if (el.video) el.video.controls = false;
      el.src = `/go2rtc/api/ws?src=${encodeURIComponent(src)}`;
    });
    return () => { alive = false; el?.remove(); }; // disconnecting the element closes the WebRTC session
  }, [stream]);
  useEffect(() => {
    const v = player.current?.video as HTMLVideoElement | undefined;
    if (v) { v.muted = !listen; if (listen) v.play().catch(() => {}); }
  });
  return <div class="cam-video" ref={host} />;
}

// Camera views ask the server to start the H.264 copies (they only run while a
// view is open), and keep asking every 30 s while the view stays open; the server
// stops them 2 minutes after the last ask. Each camera waits only for its own copy.
function useWarm() {
  useEffect(() => {
    const ask = () => fetch("/api/cameras/warm", { method: "POST" }).catch(() => {});
    ask();
    const t = setInterval(ask, 30_000);
    return () => clearInterval(t);
  }, []);
}

// Resolves once go2rtc has a publisher for the stream (a copy that's still starting),
// or after a few seconds, letting the player try anyway.
async function untilPublished(stream: string, alive: () => boolean) {
  for (let i = 0; i < 40 && alive(); i++) {
    const d = await fetch(`/go2rtc/api/streams?src=${encodeURIComponent(stream)}`).then((r) => r.json()).catch(() => ({}));
    if ((d.producers ?? []).length) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

type Camera = { id: string; name: string };

// Camera list from go2rtc's stream names: "front", "front_low", "doorbell_package"...
function useCameras(): Camera[] {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    fetch("/go2rtc/api/streams").then((r) => r.json()).then((s: Record<string, unknown>) =>
      setIds(Object.keys(s).filter((n) => !/_(low|package|h264)$/.test(n))));
  }, []);
  // Sorted and named at render time, so it's right even if the config arrives later.
  // Cameras listed in config `order` first, then the rest alphabetically.
  const first = cameraConfig.order ?? [];
  return [...ids]
    .sort((a, b) => ((first.indexOf(a) + 1 || 99) - (first.indexOf(b) + 1 || 99)) || a.localeCompare(b))
    .map((id) => ({ id, name: nameOf(id) }));
}

function FullCam({ cam, onClose }: { cam: Camera; onClose: () => void }) {
  const [talking, setTalking] = useState(false);
  return (
    <div class="cam-full with-bar">
      <div class="cam-full-video" onClick={onClose}>
        <Cam stream={cam.id} listen={cam.id === doorbell() ? talking : undefined} />
        {cam.id === doorbell() && <div class="cam-inset"><Cam stream={`${cam.id}_package`} /></div>}
        <span class="cam-name big">{cam.name}</span>
      </div>
      <button class="cam-close" onClick={onClose} aria-label="Back to grid">✕</button>
      <ActionBar onTalk={setTalking} />
    </div>
  );
}

// Closes on its own after `idleS` without a tap, so 14 streams don't run all day.
export function Cameras({ onClose, idleS }: { onClose: () => void; idleS: number }) {
  const cams = useCameras();
  useWarm();
  const [open, setOpen] = useState<Camera>();
  const idle = useRef(0);
  const touch = () => { clearTimeout(idle.current); idle.current = setTimeout(onClose, idleS * 1000) as unknown as number; };
  useEffect(() => { touch(); return () => clearTimeout(idle.current); }, []);
  return (
    <div class="cameras" onPointerDown={touch}>
      <header class="cam-bar">
        <span>Cameras</span>
        <button class="cam-close" onClick={onClose} aria-label="Close">✕</button>
      </header>
      <div class="cam-grid">
        {cams.map((c) => (
          <button class="cam-tile" onClick={() => setOpen(c)}>
            <Cam stream={`${c.id}_low`} />
            <span class="cam-name">{c.name}</span>
          </button>
        ))}
      </div>
      {open && <FullCam cam={open} onClose={() => setOpen(undefined)} />}
    </div>
  );
}

// ---- Live view ----------------------------------------------------------------

export type LiveConfig = {
  default: string;
  motion_cameras: string[];
  hold_s: number;
  open_on: { camera: string; kind: string; close_after_s?: number; chime?: boolean }[];
  close_after_s: number;
  manual_close_after_s: number;
};
type Activity = { camera: string; kind: string; active: boolean; type: string; cameraActive: boolean };


// Tracks Protect activity: which motion cameras are "in" the view right now, and
// whether the frame should be showing the live view at all.
export function useLive(cfg: LiveConfig | undefined) {
  const [, tick] = useState(0);
  const st = useRef({
    active: new Set<string>(),  // motion cameras with an event in progress (shown with a red dot)
    busy: new Set<string>(),    // any camera this view cares about with an event in progress
    until: new Map<string, number>(), order: [] as string[], openUntil: 0, manual: false,
    lead: undefined as { camera: string; until: number } | undefined, // e.g. the doorbell after a ring
  });
  useEffect(() => {
    if (!cfg) return;
    const s = st.current;
    const es = new EventSource("/api/live");
    // On (re)connect the server replays what's in progress, so start from a clean slate.
    es.onopen = () => { s.active.clear(); s.busy.clear(); tick((n) => n + 1); };
    es.onmessage = (m) => {
      const a: Activity = JSON.parse(m.data);
      const now = Date.now();
      const relevant = a.camera === cfg.default || cfg.motion_cameras.includes(a.camera);
      // A camera is in the view while any of its events is in progress, then for hold_s.
      if (cfg.motion_cameras.includes(a.camera) && a.camera !== cfg.default) {
        if (a.cameraActive) {
          s.active.add(a.camera);
          if (!s.order.includes(a.camera)) s.order.push(a.camera);
        } else if (s.active.delete(a.camera)) {
          s.until.set(a.camera, now + cfg.hold_s * 1000);
        }
      }
      if (relevant) { if (a.cameraActive) s.busy.add(a.camera); else s.busy.delete(a.camera); }
      const rule = a.active ? cfg.open_on.find((o) => o.camera === a.camera && o.kind === a.kind) : undefined;
      if (rule) {
        if (s.openUntil <= now) s.manual = false; // a fresh motion-opened view
        s.openUntil = Math.max(s.openUntil, now + (rule.close_after_s ?? cfg.close_after_s) * 1000);
        if (rule.kind === "ring") s.lead = { camera: rule.camera, until: Infinity }; // leads until the view closes
        if (rule.chime) chime();
      } else if (relevant && s.openUntil > now) {
        // Activity starting or ending keeps it open (the server sends each end once).
        s.openUntil = Math.max(s.openUntil, now + cfg.close_after_s * 1000);
      }
      tick((n) => n + 1);
    };
    // Every second: expire holds, and while any camera still has motion, don't
    // let the close timer run out (it counts from when the last motion ends).
    const t = setInterval(() => {
      const now = Date.now();
      if (s.openUntil > now && s.busy.size) s.openUntil = Math.max(s.openUntil, now + cfg.close_after_s * 1000);
      tick((n) => n + 1);
    }, 1000);
    return () => { es.close(); clearInterval(t); };
  }, [cfg]);

  const s = st.current, now = Date.now();
  s.order = s.order.filter((c) => s.active.has(c) || (s.until.get(c) ?? 0) > now);
  if (s.lead && (s.lead.until <= now || s.openUntil <= now)) s.lead = undefined;
  const lead = s.lead?.camera;
  return {
    // The ringing doorbell leads (main, top tile); then the default camera; then cameras with motion.
    cameras: cfg ? [...new Set([...(lead ? [lead] : []), cfg.default, ...s.order])] : [],
    open: s.openUntil > now,
    moving: new Set(s.active),
    close: () => { s.openUntil = 0; s.lead = undefined; tick((n) => n + 1); },
    // Camera button on the photo screen: stays up longer than a motion-opened view.
    openManual: () => { if (cfg) { s.manual = true; s.openUntil = Date.now() + cfg.manual_close_after_s * 1000; tick((n) => n + 1); } },
    // Someone is using the view (Talk, Unlock, Garage): keep it open.
    ping: () => {
      if (!cfg || s.openUntil <= Date.now()) return;
      s.openUntil = Math.max(s.openUntil, Date.now() + (s.manual ? cfg.manual_close_after_s : cfg.close_after_s) * 1000);
    },
  };
}

export function LiveView({ cameras, moving, onClose, onActivity, onAll }:
  { cameras: string[]; moving: Set<string>; onClose: () => void; onActivity: () => void; onAll: () => void }) {
  const [talking, setTalking] = useState(false);
  useWarm();
  // Talking always shows the doorbell, even if it has no motion.
  const bell = doorbell();
  const shown = talking && bell && !cameras.includes(bell) ? [...cameras, bell] : cameras;
  return (
    <div class="live-wrap with-bar" onPointerDown={onActivity /* any tap keeps it open */}>
      <div class={`live${shown.length > 3 ? " many" : ""}`}>
        {shown.map((c, i) => (
          <div class={`live-tile${i === 0 ? " main" : ""}${i === 0 && c === bell ? " portrait" : ""}`} key={c}>
            <Cam stream={c} listen={c === bell ? talking : undefined} />
            <span class="cam-name">{nameOf(c)}{moving.has(c) && <b class="motion-dot" />}</span>
          </div>
        ))}
      </div>
      <button class="cam-all" onClick={onAll}>All cameras</button>
      <button class="cam-close live-close" onClick={onClose} aria-label="Close">✕</button>
      <ActionBar onTalk={setTalking} onActivity={onActivity} />
    </div>
  );
}

// ---- Talk / Unlock / Garage bar ---------------------------------------------------

// The device key comes from the Cozyla's start URL (?key=…) and is remembered.
function deviceKey() {
  const k = new URLSearchParams(location.search).get("key");
  try { if (k) localStorage.setItem("frame-key", k); return k ?? localStorage.getItem("frame-key") ?? ""; } catch { return k ?? ""; }
}

async function act(action: string) {
  const r = await fetch("/api/action", { method: "POST", headers: { "content-type": "application/json", "x-frame-key": deviceKey() }, body: JSON.stringify({ action }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? String(r.status));
}

type Doors = { locks: { id: string; name: string; state: string }[]; garage: string };

function useDoors() {
  const [doors, setDoors] = useState<Doors>();
  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/doors").then((r) => r.json()).then((d) => alive && !d.error && setDoors(d)).catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return doors;
}

// Mic → frame-server (WebM/Opus chunks) → ffmpeg → doorbell speaker.
function useTalk(onChange: (on: boolean) => void) {
  const [on, setOn] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const st = useRef<{ stop?: () => void }>({});

  const start = async () => {
    setError("");
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/talk?key=${encodeURIComponent(deviceKey())}`);
      const rec = new MediaRecorder(mic, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32000 });
      rec.ondataavailable = (e) => { if (e.data.size && ws.readyState === WebSocket.OPEN) ws.send(e.data); };
      ws.onopen = () => rec.start(100); // 100 ms chunks
      // Level meter.
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(mic).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const meter = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(1, peak / 64));
      }, 80);
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(meter);
        if (rec.state !== "inactive") rec.stop();
        mic.getTracks().forEach((t) => t.stop());
        ws.close();
        ctx.close().catch(() => {});
        setOn(false); setLevel(0); onChange(false);
      };
      ws.onclose = (e) => { if (e.code !== 1000 && e.code !== 1005) setError("Talk disconnected"); stop(); };
      st.current.stop = stop;
      setOn(true); onChange(true);
    } catch (e) {
      setError((e as Error).name === "NotAllowedError" ? "Microphone not allowed" : "Can't start Talk");
    }
  };
  useEffect(() => () => st.current.stop?.(), []);
  return { on, level, error, toggle: () => (on ? st.current.stop?.() : start()) };
}

function ActionBar({ onTalk, onActivity }: { onTalk: (on: boolean) => void; onActivity?: () => void }) {
  const doors = useDoors();
  const talk = useTalk(onTalk);
  const [msg, setMsg] = useState("");
  // After a tap, wait for HA to report the change before the button can be used
  // again. A garage door's state can lag the tap by several seconds, and a second
  // pulse in that gap would stop or reverse the door.
  const [pending, setPending] = useState<{ action: string; from: string; until: number }>();

  // Keep the live view open while Talk is on.
  useEffect(() => {
    if (!talk.on || !onActivity) return;
    onActivity();
    const t = setInterval(onActivity, 5000);
    return () => clearInterval(t);
  }, [talk.on]);

  const run = async (action: string, from: string, waitS: number) => {
    onActivity?.();
    setMsg("");
    setPending({ action, from, until: Date.now() + waitS * 1000 });
    try { await act(action); } catch (e) { setMsg((e as Error).message); setPending(undefined); }
  };
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(""), 6000); return () => clearTimeout(t); }, [msg]);

  // Pending ends when the state moves on from where it was, or after the wait.
  const g = doors?.garage;
  const stateOf = (action: string) => action === "garage" ? g : doors?.locks.find((l) => l.id === action.split(":")[1])?.state;
  const isPending = (action: string, now: string | undefined) =>
    pending?.action === action && pending.from === now && Date.now() < pending.until;
  useEffect(() => {
    if (!pending) return;
    if (stateOf(pending.action) !== pending.from || Date.now() >= pending.until) setPending(undefined);
  });

  // One button per door: Unlock when locked; when unlocked it turns green and a
  // tap locks it again.
  const lockButton = ({ id, name, state }: Doors["locks"][number]) => {
    const unlocked = state === "unlocked" || state === "open";
    const unlocking = state === "unlocking" || isPending(`unlock:${id}`, state);
    const locking = state === "locking" || isPending(`lock:${id}`, state);
    const label = locking ? "Locking…" : unlocking ? "Unlocking…" : state === "jammed" ? "Jammed"
      : unlocked ? "Unlocked" : "Unlock";
    const known = ["locked", "unlocked", "open", "locking", "unlocking", "jammed"].includes(state);
    return (
      <button key={id} class={`action unlock${unlocked && !locking ? " done" : ""}`}
        onClick={() => run(`${unlocked ? "lock" : "unlock"}:${id}`, state, 15)} disabled={!known || unlocking || locking}>
        <span class="aicon">{unlocked ? "🔓" : "🔒"}</span>
        <span>{label}</span>
        <small class="hint">{unlocked && !locking ? "Tap to lock" : name}</small>
      </button>
    );
  };

  // The label follows the door's state: Open when closed, Close when open. Until
  // the door reports a known state, the button stays off.
  const garageWaiting = isPending("garage", g);
  const garageLabel = g === "opening" || (garageWaiting && g === "closed") ? "Opening…"
    : g === "closing" || (garageWaiting && g === "open") ? "Closing…"
    : g === "closed" ? "Open garage" : g === "open" ? "Close garage" : "Garage";
  const garageReady = (g === "open" || g === "closed") && !garageWaiting;

  return (
    <div class="action-bar" onClick={(e) => e.stopPropagation()}>
      {(msg || talk.error) && <div class="action-msg">{msg || talk.error}</div>}
      <button class={`action talk${talk.on ? " on" : ""}`} onClick={() => { onActivity?.(); talk.toggle(); }}>
        <span class="aicon">{talk.on ? "■" : "🎙"}</span>
        <span>{talk.on ? "Stop" : "Talk"}</span>
        {talk.on && <i class="level" style={{ transform: `scaleX(${talk.level})` }} />}
      </button>
      {doors?.locks.map(lockButton)}
      <button class={`action garage ${g ?? ""}`} onClick={() => run("garage", g ?? "", 30)} disabled={!garageReady}>
        <span class="aicon">🚗</span>
        <span>{garageLabel}</span>
      </button>
    </div>
  );
}
