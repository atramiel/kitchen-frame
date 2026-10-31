// Talk to the doorbell: the page streams its microphone (WebM/Opus chunks from
// MediaRecorder) over a WebSocket; ffmpeg re-encodes to what Protect's talkback
// session asks for (Opus, 24 kHz mono) and sends it as RTP to the doorbell.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { WebSocket } from "ws";
import { Agent } from "undici";

export function createTalk(root: string, cameraId: string) {
  const env = Object.fromEntries(readFileSync(join(root, "secrets", "protect.env"), "utf8")
    .split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
  // launchd's PATH has no Homebrew, so look in the usual places.
  const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => existsSync(p)) ?? "ffmpeg";

  async function session(): Promise<{ url: string; codec: string; samplingRate: number }> {
    const res = await fetch(`https://${env.PROTECT_HOST}/proxy/protect/integration/v1/cameras/${cameraId}/talkback-session`, {
      method: "POST", headers: { "X-API-KEY": env.PROTECT_API_KEY },
      dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
    } as RequestInit);
    if (!res.ok) throw new Error(`talkback-session: ${res.status}`);
    return res.json();
  }

  return async function handle(ws: WebSocket) {
    // The page starts sending audio as soon as the socket opens, while the talkback
    // session is still being set up. Hold those chunks: the first one carries the
    // WebM header, and without it ffmpeg can't read anything that follows.
    const early: Buffer[] = [];
    let closed = false;
    const hold = (chunk: Buffer) => early.push(chunk);
    ws.on("message", hold);
    ws.once("close", () => (closed = true));
    let s;
    try { s = await session(); } catch (e) { ws.close(1011, (e as Error).message); return; }
    if (closed) return;
    console.log(`talk: started → ${s.url} (${s.codec} ${s.samplingRate} Hz)`);
    const ff = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "warning",
      "-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "4096", "-analyzeduration", "0",
      "-f", "webm", "-i", "pipe:0",
      "-ac", "1", "-ar", String(s.samplingRate), "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-frame_duration", "20",
      "-f", "rtp", s.url,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    ff.stderr.on("data", (d) => console.log("talk ffmpeg:", d.toString().trim()));
    ff.stdin.on("error", () => {});
    ws.off("message", hold);
    for (const chunk of early) ff.stdin.write(chunk);
    ws.on("message", (chunk) => ff.stdin.write(chunk as Buffer));
    ws.on("close", () => { ff.stdin.end(); setTimeout(() => ff.kill("SIGTERM"), 500); console.log("talk: stopped"); });
    ff.on("exit", () => ws.close());
  };
}
