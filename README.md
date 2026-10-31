# Kitchen Frame

A self-hosted kitchen display for a wall tablet (built for a Cozyla 32" portrait
screen running Fully Kiosk), replacing DAKboard and a separate camera viewer:

- **Photo frame**: an iCloud shared album, a 4-day calendar from Home Assistant,
  weather (NWS) and outdoor air quality. Tap the left or right of the photo to
  step through it.
- **Live camera view**: opens on driveway motion or a doorbell ring (with a
  chime), shows a default camera plus any outdoor camera with motion, and goes
  back to photos once nobody is outside. A camera button opens it by hand, and
  "All cameras" shows every camera.
- **Talk, Unlock/Lock, Garage**: talk through the UniFi doorbell, lock or unlock
  the front door, open or close the garage, all from the camera views.

It runs on a Mac (mini) on the home network. Nothing is exposed to the internet.

## How it fits together

```
tablet (Fully Kiosk) ── https://<mac>/ ── frame-server (Node, this repo)
                                            ├─ Home Assistant: calendars, weather, AQI, lock, garage
                                            ├─ UniFi Protect: camera events, doorbell talkback
                                            ├─ iCloud shared album: photos (resized and cached)
                                            └─ go2rtc: camera video over WebRTC
```

- `server/`: frame-server. `index.ts` (HTTP, APIs, proxies), `ha.ts` (Home
  Assistant), `protect.ts` (Protect event feed), `photos.ts` (iCloud album),
  `actions.ts` (door controls), `talk.ts` (doorbell talkback), `transcode.ts`
  (H.264 copies of camera streams while a camera view is open).
- `web/`: the page (Preact + Vite), laid out at 1080x1920 and scaled to the screen.
- `scripts/`: setup helpers (secrets, certificate, go2rtc streams, LaunchAgents,
  switching the tablet).
- `launchd/`: LaunchAgent templates for frame-server and go2rtc.

## Layout on disk

This folder is `app/` inside a project folder that also holds the parts that
aren't in git:

```
kitchen-frame/
  app/       this repo
  bin/       go2rtc binary (scripts/install-go2rtc.sh)
  config/    config.yaml (from config.example.yaml), go2rtc.yaml (generated)
  secrets/   *.env, mode 600 (scripts/set-secret.sh)
  certs/     private CA and the LAN certificate (scripts/make-cert.sh)
  cache/     photo cache
  logs/
```

## Setup (macOS, Apple silicon)

1. `brew install node ffmpeg`, then `npm install` and `npm run build` here.
2. `scripts/install-go2rtc.sh` puts go2rtc in `../bin`.
3. Secrets, each prompted for without echo:
   - `scripts/set-secret.sh ha HA_TOKEN` (a Home Assistant long-lived token)
   - `scripts/set-secret.sh protect PROTECT_HOST PROTECT_API_KEY` (Protect → Settings → Control Plane → Integrations)
   - `../secrets/device.env` with `DEVICE_KEY=<random hex>`: the tablet's start URL carries it, and the door controls and Talk only work with it.
4. Copy `config.example.yaml` to `../config/config.yaml` and fill it in.
5. `node scripts/protect-streams.mjs <mac-lan-ip>` writes `../config/go2rtc.yaml`.
6. `scripts/make-cert.sh <mac-lan-ip>` makes the HTTPS certificate.
7. `scripts/install-agents.sh` installs and starts both LaunchAgents. macOS will
   ask once to allow go2rtc and node on the local network.
8. `node scripts/cozyla.mjs frame` points the tablet's Fully Kiosk at the frame
   (through Home Assistant's Fully Kiosk integration).

Preview on the Mac: `FRAME_DEV_HTTP=1 node server/dist/index.js`, then open
http://127.0.0.1:8080.
