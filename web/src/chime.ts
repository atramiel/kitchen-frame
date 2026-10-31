// Doorbell chime: a two-note "ding-dong", played twice, synthesized with Web Audio
// (no sound file). Browsers only allow sound after the page has been tapped once,
// or when the kiosk browser allows autoplay (Fully Kiosk: "Autoplay audio").
let ctx: AudioContext | undefined;
let lastRing = 0;

function audio() {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

// Any tap on the page unlocks audio for later rings.
addEventListener("pointerdown", () => audio(), { once: true, capture: true });

function note(c: AudioContext, freq: number, at: number, volume: number) {
  // A bell-ish tone: fundamental plus a quieter overtone, quick attack, long decay.
  for (const [mult, gain] of [[1, 1], [2.76, 0.25]] as const) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = "sine";
    o.frequency.value = freq * mult;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(volume * gain, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 1.6);
    o.connect(g).connect(c.destination);
    o.start(at);
    o.stop(at + 1.7);
  }
}

export function chime(volume = 0.6) {
  if (Date.now() - lastRing < 5000) return; // one ring can be reported twice (Protect and HA)
  lastRing = Date.now();
  const c = audio(), t = c.currentTime + 0.05;
  for (const start of [0, 2.2]) {
    note(c, 659.25, t + start, volume);       // E5 "ding"
    note(c, 523.25, t + start + 0.55, volume); // C5 "dong"
  }
}
