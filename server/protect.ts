// Live camera activity straight from UniFi Protect's integration event feed
// (faster than going through HA, and HA doesn't expose line crossings).
// Emits { camera, kind, active, cameraActive } where camera is the go2rtc stream
// name (the slugged Protect camera name), kind is "motion" | "line" | "smart" |
// "ring", active is this event's state, and cameraActive says whether the camera
// still has any event in progress (motion and a person detection often overlap).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { Agent } from "undici";

export type Activity = { camera: string; kind: string; active: boolean; type: string; cameraActive: boolean };

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// Protect event types → our kinds. Unknown types are logged so new ones can be mapped.
function kindOf(type: string) {
  if (type === "motion") return "motion";
  if (/line/i.test(type)) return "line";
  if (type === "ring") return "ring";
  if (/^smart/i.test(type)) return "smart";
}

export function createProtectFeed(root: string) {
  const env = Object.fromEntries(readFileSync(join(root, "secrets", "protect.env"), "utf8")
    .split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
  const host = env.PROTECT_HOST, key = env.PROTECT_API_KEY;
  const feed = new EventEmitter();
  const cameras = new Map<string, string>(); // Protect device id → stream name
  const open = new Map<string, Activity & { at: number }>(); // event id → activity still in progress
  const ended = new Set<string>(); // ids already reported ended; Protect repeats "ended" updates
  const STALE_MS = 3 * 60_000;     // an event with no end after this long is treated as ended

  async function loadCameras() {
    const res = await fetch(`https://${host}/proxy/protect/integration/v1/cameras`, {
      headers: { "X-API-KEY": key }, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
    } as RequestInit);
    for (const c of await res.json()) cameras.set(c.id, slug(c.name));
  }

  function connect() {
    const ws = new WebSocket(`wss://${host}/proxy/protect/integration/v1/subscribe/events`,
      { headers: { "X-API-KEY": key }, rejectUnauthorized: false });
    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const ev = msg.item;
      if (!ev || ev.modelKey !== "event") return;
      const camera = cameras.get(ev.device);
      const kind = kindOf(ev.type);
      console.log(`protect event ${msg.type} ${ev.type} ${camera ?? ev.device}${ev.end ? " (ended)" : ""}${ev.smartDetectTypes?.length ? ` [${ev.smartDetectTypes}]` : ""}`);
      if (!camera || !kind || ended.has(ev.id)) return;
      const active = !ev.end;
      if (active) {
        if (open.has(ev.id)) return; // progress update for an event already reported
        open.set(ev.id, { camera, kind, active, type: ev.type, cameraActive: true, at: Date.now() });
      } else {
        open.delete(ev.id);
        ended.add(ev.id);
        if (ended.size > 500) ended.delete(ended.values().next().value!);
      }
      feed.emit("activity", { camera, kind, active, type: ev.type, cameraActive: cameraBusy(camera) });
    });
    // Protect can stop sending without closing the connection (seen: 2+ hours of
    // silence one morning). Ping it, and drop the connection if it stops answering.
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) { console.error("protect feed: no answer to ping, reconnecting"); return ws.terminate(); }
      alive = false;
      ws.ping();
    }, 20_000);
    ws.on("pong", () => { alive = true; });
    ws.on("message", () => { alive = true; });
    ws.on("open", () => console.log("protect feed: connected"));
    ws.on("close", (code) => { clearInterval(heartbeat); console.log(`protect feed: closed (${code}), reconnecting`); setTimeout(connect, 3000); });
    ws.on("error", (e) => console.error("protect feed:", e.message));
  }

  const cameraBusy = (camera: string) => [...open.values()].some((a) => a.camera === camera);

  // Events whose end never arrived (e.g. the feed dropped) shouldn't hold a camera forever.
  setInterval(() => {
    for (const [id, a] of open) {
      if (Date.now() - a.at < STALE_MS) continue;
      open.delete(id);
      ended.add(id);
      feed.emit("activity", { ...a, active: false, cameraActive: cameraBusy(a.camera) });
    }
  }, 30_000);

  const start = () => loadCameras().then(connect).catch((e) => { console.error("protect cameras:", e.message); setTimeout(start, 10_000); });
  start();

  return {
    on: (fn: (a: Activity) => void) => feed.on("activity", fn),
    off: (fn: (a: Activity) => void) => feed.off("activity", fn),
    // Activity from elsewhere (HA's doorbell event, dev previews). Tracked like a
    // Protect event so it can't mark a camera idle while its motion is still going.
    inject: (a: Omit<Activity, "cameraActive">) => {
      const id = `injected:${a.camera}:${a.kind}:${a.type}`;
      if (a.active) open.set(id, { ...a, cameraActive: true, at: Date.now() }); else open.delete(id);
      feed.emit("activity", { ...a, cameraActive: cameraBusy(a.camera) });
    },
    // Activities already in progress, for a client that just connected.
    current: (): Activity[] => [...open.values()].map(({ at, ...a }) => a),
  };
}
