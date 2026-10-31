// H.264 copies of the camera streams, run only while someone is looking.
// The tablet's browser plays H.265 poorly (choppy, slow to start), and a new
// viewer otherwise waits for the camera's next keyframe. So ffmpeg re-encodes
// each stream on the Mac's hardware encoder with a keyframe every half second
// and publishes it back into go2rtc as <stream>_h264.
//
// Copies start when a camera view opens (the page calls warm(), and camera
// activity that opens the view warms them straight away) and stop `idleMs` after
// the last request, so the cameras aren't streamed to the Mac all day.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => existsSync(p)) ?? "ffmpeg";
const GO2RTC_RTSP = "rtsp://127.0.0.1:8554"; // go2rtc's RTSP server, localhost only

// Low (grid) streams are small; a lower bitrate is plenty.
const bitrate = (stream: string) => (stream.endsWith("_low") ? "700k" : "4M");

export function createTranscodes(streams: string[], go2rtcApi: string, idleMs = 2 * 60_000) {
  const procs = new Map<string, ChildProcess>();
  let idleTimer: NodeJS.Timeout | undefined;

  function run(stream: string, delayMs = 0) {
    setTimeout(() => {
      if (!idleTimer) return; // stopped while waiting to restart
      const ff = spawn(FFMPEG, [
        "-hide_banner", "-loglevel", "error",
        "-rtsp_transport", "tcp", "-i", `${GO2RTC_RTSP}/${stream}`,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "h264_videotoolbox", "-realtime", "1", "-b:v", bitrate(stream), "-g", "10", "-bf", "0", "-profile:v", "high",
        "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1",
        "-f", "rtsp", "-rtsp_transport", "tcp", `${GO2RTC_RTSP}/${stream}_h264`,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      procs.set(stream, ff);
      ff.stderr!.on("data", (d) => {
        // Joining a camera mid-stream, the decoder complains until the next keyframe; that's expected.
        const lines = d.toString().split("\n").filter((l: string) => l.trim() && !/Could not find ref with POC|Error constructing the frame RPS|^\s*\[hevc @ 0x[0-9a-f]+\]\s*$/.test(l));
        if (lines.length) console.error(`transcode ${stream}:`, lines.join(" | ").slice(0, 300));
      });
      ff.on("exit", (code, signal) => {
        procs.delete(stream);
        if (signal === "SIGTERM" || !idleTimer) return; // stopped on purpose
        console.log(`transcode ${stream}: exited (${code}), restarting`);
        run(stream, 3000); // camera reboot, go2rtc restart, network blip: try again
      });
    }, delayMs);
  }

  function stop() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    procs.forEach((p) => p.kill("SIGTERM"));
    if (procs.size) console.log("transcodes: stopped (cameras idle)");
  }

  // True once go2rtc has a publisher for the stream's copy.
  async function published(stream: string) {
    try {
      const d = await (await fetch(`${go2rtcApi}/api/streams?src=${stream}_h264`)).json();
      return (d.producers ?? []).length > 0;
    } catch { return false; }
  }

  // Start (or keep running) every copy. Resolves once they're all publishing,
  // or after `waitMs`, so the page can connect without hitting an empty stream.
  async function warm(waitMs = 6000) {
    const cold = !idleTimer;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, idleMs);
    if (cold) {
      console.log(`transcodes: starting ${streams.length} copies`);
      streams.forEach((s) => { if (!procs.has(s)) run(s); });
    }
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      const ready = await Promise.all(streams.map(published));
      if (ready.every(Boolean)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  process.on("exit", stop);
  process.on("SIGTERM", () => { stop(); process.exit(0); });
  return { warm, stop };
}
