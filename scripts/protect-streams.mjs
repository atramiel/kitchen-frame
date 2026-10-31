#!/usr/bin/env node
// Builds <root>/config/go2rtc.yaml from the Protect integration API.
// Needs <root>/secrets/protect.env with PROTECT_HOST and PROTECT_API_KEY.
// Stream names: slugged camera name (medium), <name>_low, and <name>_package
// for cameras that have a package channel.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";
import YAML from "yaml";

const FRAME = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // app/scripts → root
const env = Object.fromEntries(
  readFileSync(join(FRAME, "secrets", "protect.env"), "utf8")
    .split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const { PROTECT_HOST: host, PROTECT_API_KEY: key } = env;
const LAN_IP = process.argv[2];
if (!host || !key || !LAN_IP) {
  console.error("usage: protect-streams.mjs <mac-lan-ip>  (and <root>/secrets/protect.env with PROTECT_HOST, PROTECT_API_KEY)");
  process.exit(1);
}

// The NVR uses a self-signed certificate; trust it for this host only.
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const base = `https://${host}/proxy/protect/integration/v1`;
async function api(path, init = {}) {
  const res = await fetch(base + path, {
    ...init, dispatcher,
    headers: { "X-API-KEY": key, "content-type": "application/json", accept: "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
// rtsps://host:7441/ALIAS?enableSrtp → rtspx://host:7441/ALIAS
const toRtspx = (u) => u.replace(/^rtsps:/, "rtspx:").replace(/\?enableSrtp.*$/, "");

const cameras = await api("/cameras");
const streams = {};
const report = [];
for (const cam of cameras) {
  await new Promise((r) => setTimeout(r, 400)); // Protect allows 10 requests/s
  const name = slug(cam.name);
  const hasPackage = (cam.featureFlags?.hasPackageCamera) ?? /entry|doorbell/i.test(cam.modelKey + cam.name);
  const wanted = ["medium", "low", ...(hasPackage ? ["package"] : [])];
  let urls = await api(`/cameras/${cam.id}/rtsps-stream`).catch(() => ({}));
  const missing = wanted.filter((q) => !urls?.[q]);
  if (missing.length) {
    const created = await api(`/cameras/${cam.id}/rtsps-stream`, { method: "POST", body: JSON.stringify({ qualities: missing }) })
      .catch((e) => { console.error(`${cam.name}: ${e.message}`); return {}; });
    urls = { ...urls, ...created };
  }
  if (urls.medium) streams[name] = toRtspx(urls.medium);
  if (urls.low) streams[`${name}_low`] = toRtspx(urls.low);
  if (urls.package) streams[`${name}_package`] = toRtspx(urls.package);
  report.push(`${cam.name.padEnd(16)} ${cam.id}  ${wanted.filter((q) => urls[q]).join(",") || "NO STREAMS"}`);
}

// Cameras that send H.265, which the Cozyla's browser plays poorly: their main
// and package streams get H.264 copies (<stream>_h264). These copies have no
// source here: frame-server's always-on ffmpeg publishes them (server/transcode.ts).
const frameConfig = YAML.parse(readFileSync(join(FRAME, "config", "config.yaml"), "utf8"));
for (const cam of frameConfig.cameras?.h264_transcode ?? []) {
  for (const s of Object.keys(streams).filter((s) => (s === cam || s.startsWith(cam + "_")) && !s.endsWith("_low"))) {
    streams[`${s}_h264`] = null; // published by frame-server's always-on ffmpeg
  }
}
// Every Low stream (the camera grid) also gets an always-on copy with frequent
// keyframes, so all the grid's tiles start at once.
for (const s of Object.keys(streams).filter((s) => s.endsWith("_low"))) streams[`${s}_h264`] = null;

const go2rtc = {
  api: { listen: "127.0.0.1:1984" },
  // go2rtc's RTSP server is localhost-only: the H.264 transcodes read from it, nothing on the LAN can.
  rtsp: { listen: "127.0.0.1:8554" },
  webrtc: { listen: ":8555", candidates: [`${LAN_IP}:8555`] },
  log: { level: "info" },
  // launchd's PATH has no Homebrew, so name ffmpeg explicitly (used for snapshots/transcodes).
  ffmpeg: { bin: execSync("command -v ffmpeg", { shell: "/bin/zsh" }).toString().trim() },
  streams,
};
writeFileSync(join(FRAME, "config", "go2rtc.yaml"), YAML.stringify(go2rtc));
console.log(report.join("\n"));
console.log(`\nwrote ${Object.keys(streams).length} streams to ${join(FRAME, "config", "go2rtc.yaml")}`);
