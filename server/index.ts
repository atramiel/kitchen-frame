// frame-server: serves the page over HTTPS on the LAN, its data (/api/ambient,
// /api/photo), live camera activity from Protect (/api/live), the door controls
// (/api/doors, /api/action) and Talk (/ws/talk), and proxies go2rtc so video
// stays on the same HTTPS origin. /ha/ proxies Home Assistant for later phases.
import { createServer as createHttps } from "node:https";
import { createServer as createHttp, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, createReadStream, statSync } from "node:fs";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import httpProxy from "http-proxy";
import YAML from "yaml";
import { createHa, pm25ToAqi } from "./ha.js";
import { createIcloudAlbum } from "./photos.js";
import { createProtectFeed, type Activity } from "./protect.js";
import { createActions } from "./actions.js";
import { createTalk } from "./talk.js";
import { createTranscodes } from "./transcode.js";
import { WebSocketServer } from "ws";
import { Agent } from "undici";

// Project root: server/dist/index.js → ../../..
const FRAME = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const config = YAML.parse(readFileSync(join(FRAME, "config", "config.yaml"), "utf8"));
const WEB_ROOT = join(FRAME, "app", "web", "dist");
const GO2RTC = config.go2rtc?.url ?? "http://127.0.0.1:1984";
const PORT = Number(config.server?.port ?? 443);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json",
  ".woff2": "font/woff2", ".mp3": "audio/mpeg",
};

// Path prefix → upstream. HA is proxied too because the page is HTTPS and HA
// is plain http on the LAN; a direct connection would be blocked as mixed content.
const upstreams: Record<string, string> = { "/go2rtc": GO2RTC, "/ha": config.ha.url };
const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });
proxy.on("error", (err, req, res) => {
  console.error(`proxy ${req.url}:`, err.message);
  if (res instanceof ServerResponse && !res.headersSent) { res.writeHead(502); res.end(); }
});

// go2rtc rejects WebSocket upgrades whose Origin doesn't match its own host;
// changeOrigin only rewrites Host, so present the upstream as the Origin too.
proxy.on("proxyReqWs", (proxyReq) => {
  proxyReq.setHeader("origin", `http://${proxyReq.getHeader("host")}`);
});

// Strips the prefix from req.url and returns the upstream, or undefined.
function route(req: IncomingMessage): string | undefined {
  const url = req.url ?? "/";
  for (const [prefix, target] of Object.entries(upstreams)) {
    if (url.startsWith(prefix + "/")) { req.url = url.slice(prefix.length); return target; }
  }
}

const ha = createHa(FRAME, config.ha.url);
const album = createIcloudAlbum(FRAME, config.photos.source.token);
// ?full = whole screen (full-bleed layout); otherwise the top-60% photo area.
const FULL_SIZE = { width: 2160, height: 3840 };

// Everything Ambient mode shows, in one payload, cached for a minute.
let ambientCache: { at: number; body: string } | undefined;
async function ambient() {
  if (ambientCache && Date.now() - ambientCache.at < 60_000) return ambientCache.body;
  const [events, weather, pm] = await Promise.all([
    ha.events(config.calendars.sources, config.calendars.days),
    ha.weather(config.weather, config.weather_station),
    ha.state(config.aqi).catch(() => undefined),
  ]);
  const pm25 = pm ? Number(pm.state) : NaN;
  // Title-based overrides (e.g. Sharks games in teal with the logo).
  const rules: { match: string; color?: string; icon?: string; logo?: string }[] = config.calendars.rules ?? [];
  for (const e of events as Record<string, unknown>[]) {
    const r = rules.find((r) => String(e.title).includes(r.match));
    if (r) Object.assign(e, { color: r.color ?? e.color, icon: r.logo ? undefined : r.icon ?? e.icon, logo: r.logo });
  }
  const body = JSON.stringify({
    events, weather,
    aqi: Number.isFinite(pm25) ? { aqi: pm25ToAqi(pm25), pm25 } : null,
    calendars: { days: config.calendars.days },
  });
  ambientCache = { at: Date.now(), body };
  return body;
}

const protect = createProtectFeed(FRAME);
// Not in dev previews: the real frame-server already runs these.
// H.264 copies of every stream whose <stream>_h264 go2rtc expects to be published
// (no source), run only while a camera view is open. Activity that opens the view
// warms them right away, before the page even asks.
const go2rtcStreams: Record<string, unknown> = YAML.parse(readFileSync(join(FRAME, "config", "go2rtc.yaml"), "utf8")).streams ?? {};
const transcodes = process.env.FRAME_DEV_HTTP
  // A local preview asks the real frame-server to run them, so there's one set of copies.
  ? { warm: (_wait?: number) => fetch(`https://127.0.0.1:${PORT}/api/cameras/warm`, { method: "POST", dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) } as RequestInit).then(() => true, () => false) }
  : createTranscodes(
    Object.entries(go2rtcStreams).filter(([n, src]) => n.endsWith("_h264") && src == null).map(([n]) => n.slice(0, -5)),
    GO2RTC,
  );
protect.on((a) => {
  if (a.active && config.live.open_on.some((o: { camera: string; kind: string }) => o.camera === a.camera && o.kind === a.kind)) {
    transcodes.warm(0);
  }
});

// Backup for doorbell rings: HA's doorbell event entity changes state (to the
// ring's timestamp) on every press. Checked every second; the page ignores a
// second ring report within a few seconds of the first.
if (config.live.ring_entity) {
  let last: string | undefined;
  setInterval(async () => {
    try {
      const { state } = await ha.state(config.live.ring_entity);
      if (last !== undefined && state !== last && state !== "unavailable" && state !== "unknown") {
        console.log("ring (from HA)");
        const camera = config.live.open_on.find((o: { kind: string }) => o.kind === "ring")?.camera ?? config.cameras.doorbell;
        protect.inject({ camera, kind: "ring", active: true, type: "ha-ring" });
        setTimeout(() => protect.inject({ camera, kind: "ring", active: false, type: "ha-ring" }), 1000);
      }
      last = state;
    } catch { /* HA briefly unreachable */ }
  }, 1000);
}

// Server-sent events: camera activity from Protect, for the live camera view.
function live(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const send = (a: Activity) => res.write(`data: ${JSON.stringify(a)}\n\n`);
  protect.current().forEach(send);
  protect.on(send);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { protect.off(send); clearInterval(ping); });
}

const actions = createActions(ha, config.actions);
const talk = createTalk(FRAME, config.actions.talk_camera_id);
const talkServer = new WebSocketServer({ noServer: true });

// Door controls and Talk need the device key, which only the Cozyla's start URL
// carries (?key=…; the page sends it back as x-frame-key or ?key=). Without it,
// a phone or laptop on the Wi-Fi can load the frame but not unlock anything.
// Local dev previews (localhost only) skip the check.
const DEVICE_KEY = readFileSync(join(FRAME, "secrets", "device.env"), "utf8").match(/^DEVICE_KEY=(\w+)/m)?.[1];
function authorized(req: IncomingMessage) {
  if (process.env.FRAME_DEV_HTTP) return true;
  const given = req.headers["x-frame-key"] ?? new URL(req.url ?? "/", "http://x").searchParams.get("key");
  return !!DEVICE_KEY && given === DEVICE_KEY;
}

function json(res: ServerResponse, body: string, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let file = normalize(join(WEB_ROOT, urlPath));
  if (!file.startsWith(WEB_ROOT)) { res.writeHead(403); return res.end(); }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(WEB_ROOT, "index.html"); // SPA fallback
  if (!existsSync(file)) { res.writeHead(503); return res.end("SPA not built: npm run build"); }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

function handler(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? "/";
  if (url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  // Client-side config: only the parts the page needs, never secrets.
  if (url === "/api/config") {
    const { photos, live, cameras } = config;
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ photos, live, cameras }));
  }
  if (url === "/api/live") return live(req, res);
  // The page reports its screen once at load (size, pixel ratio, browser), for diagnosing the tablet.
  if (url.startsWith("/api/hello")) { console.log(`page loaded: ${decodeURIComponent(url.split("?")[1] ?? "")}`); return json(res, "{}"); }
  // Dev previews only: fake a Protect event, e.g. /api/live/test?camera=front&kind=line&active=1
  if (process.env.FRAME_DEV_HTTP && url.startsWith("/api/live/test")) {
    const q = new URL(url, "http://x").searchParams;
    protect.inject({ camera: q.get("camera")!, kind: q.get("kind") ?? "motion", active: q.get("active") !== "0", type: "test" });
    return json(res, "{}");
  }
  // A camera view is open (or still open): make sure the H.264 copies are running.
  // Answers once they're publishing, so the page can connect straight away.
  if (url === "/api/cameras/warm" && req.method === "POST") {
    return void transcodes.warm().then((ready) => json(res, JSON.stringify({ ready })));
  }
  if (url === "/api/doors") {
    return void actions.states().then((s) => json(res, JSON.stringify(s)), (e) => json(res, JSON.stringify({ error: e.message }), 502));
  }
  if (url === "/api/action" && req.method === "POST") {
    if (!authorized(req)) return json(res, JSON.stringify({ error: "not allowed from this device" }), 403);
    let body = "";
    req.on("data", (c) => (body += c));
    return void req.on("end", () => {
      let action = "";
      try { action = JSON.parse(body).action; } catch {}
      console.log(`action ${action}`);
      actions.run(action).then(() => json(res, "{}"), (e) => json(res, JSON.stringify({ error: e.message }), 400));
    });
  }
  if (url === "/api/ambient") {
    return void ambient().then((b) => json(res, b), (e) => json(res, JSON.stringify({ error: e.message }), 502));
  }
  if (url.startsWith("/api/photo")) {
    return void album.next(url.includes("full") ? FULL_SIZE : config.photos.size).then((photo) => {
      if (!photo) { res.writeHead(503); return res.end("no photos yet"); }
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store", ...(photo.taken && { "x-photo-taken": photo.taken }) });
      res.end(photo.img);
    }, (e) => { res.writeHead(502); res.end(e.message); });
  }
  const target = route(req);
  if (target) return proxy.web(req, res, { target });
  serveStatic(req, res);
}

// LAN certificate from app/scripts/make-cert.sh (private CA, no public domain).
const certFile = join(FRAME, "certs", "frame.crt");
const keyFile = join(FRAME, "certs", "frame.key");
// FRAME_DEV_HTTP=1 runs plain http on dev_port (localhost previews only).
const tls = !process.env.FRAME_DEV_HTTP && existsSync(certFile) && existsSync(keyFile);

const server = tls
  ? createHttps({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, handler)
  : createHttp(handler);

server.on("upgrade", (req, socket, head) => {
  if ((req.url ?? "").startsWith("/ws/talk")) {
    if (!authorized(req)) return socket.destroy();
    return talkServer.handleUpgrade(req, socket, head, (ws) => talk(ws));
  }
  const target = route(req);
  if (target) proxy.ws(req, socket, head, { target });
  else socket.destroy();
});

const port = tls ? PORT : Number(config.server?.dev_port ?? 8080);
server.listen(port, process.env.FRAME_DEV_HTTP ? "127.0.0.1" : undefined, () => console.log(`frame-server on ${tls ? "https" : "http"}://0.0.0.0:${port}`));
