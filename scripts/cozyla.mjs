#!/usr/bin/env node
// Switches the Cozyla's Fully Kiosk browser to the frame, or back to DAKboard.
// Goes through Home Assistant's Fully Kiosk integration, using secrets/ha.env, and
// puts the device key (secrets/device.env) in the start URL so it never has to be
// typed or shown anywhere.
//   node app/scripts/cozyla.mjs frame      → frame, plus the settings it needs
//   node app/scripts/cozyla.mjs dakboard   → back to the old DAKboard page
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const secret = (file, key) => readFileSync(join(ROOT, "secrets", file), "utf8").match(new RegExp(`^${key}=(.+)$`, "m"))?.[1].trim();
const config = YAML.parse(readFileSync(join(ROOT, "config", "config.yaml"), "utf8"));
const { device_id, frame_url, dakboard_url, load_start_url } = config.cozyla;
const HA = config.ha.url, TOKEN = secret("ha.env", "HA_TOKEN");

async function call(domain, service, data) {
  const res = await fetch(`${HA}/api/services/${domain}/${service}`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`${domain}.${service}: ${res.status} ${await res.text()}`);
}
const set = (key, value) => call("fully_kiosk", "set_config", { device_id, key, value: String(value) });

const target = process.argv[2];
if (target === "frame") {
  await set("ignoreSSLerrors", true);  // the frame's certificate comes from our own private CA
  await set("autoplayAudio", true);    // the doorbell chime can play without a tap first
  await set("microphoneAccess", true); // Talk (Android may ask once on the screen to allow the mic)
  await set("startURL", `${frame_url}?key=${secret("device.env", "DEVICE_KEY")}`);
  console.log("Cozyla start page set to the frame (with its device key).");
} else if (target === "dakboard") {
  await set("startURL", dakboard_url);
  console.log("Cozyla start page set back to DAKboard.");
} else {
  console.error("usage: cozyla.mjs frame | dakboard");
  process.exit(1);
}
await call("button", "press", { entity_id: load_start_url });
console.log("Reloaded the Cozyla.");
