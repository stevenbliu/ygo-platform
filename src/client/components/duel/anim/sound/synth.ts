// Sound core: the audio context, mute / volume / buses, the shared reverb and the synth building blocks
// (tone, noise, bell, ...). Themes (themes.ts) and play() (../sfx.ts) are built from these.

export type Sfx = "draw" | "summon" | "set" | "attack" | "damage" | "gain" | "chain" | "resolve" | "turn" | "shuffle" | "win" | "lose" | "pick"
  // summons
  | "sum-normal" | "sum-tribute" | "sum-set" | "sum-flip" | "sum-special" | "sum-ritual" | "sum-fusion" | "sum-synchro" | "sum-xyz" | "sum-link" | "sum-pendulum"
  // activations
  | "act-spell" | "act-quick" | "act-trap" | "act-counter" | "act-monster"
  // moments
  | "splash" | "splash-big" | "boss" | "chain-link"
  // turns and phases (the banner moments)
  | "turn-mine" | "turn-theirs" | "phase-main1" | "phase-battle" | "phase-main2" | "phase-end"
  // a chain link resolving, one per resolve animation style
  | `resolve-${"rings" | "sparkle" | "fireworks" | "aura" | "powerup" | "holy" | "void" | "electric" | "circle" | "frost" | "minimal"}`;

export const KEY = "duel-sfx-muted";
export let ctx: AudioContext | null = null;
export let muted = (() => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } })();
export const listeners = new Set<() => void>();
export const lastAt = new Map<string, number>();

export const isMuted = () => muted;

// master volume (0..1), remembered; every sound goes through one gain node (and a soft limiter)
export const VOL_KEY = "duel-sfx-volume";
export let volume = (() => { try { const v = Number(localStorage.getItem(VOL_KEY)); return Number.isFinite(v) && localStorage.getItem(VOL_KEY) !== null ? Math.min(1, Math.max(0, v)) : 0.7; } catch { return 0.7; } })();
export let masterGain: GainNode | null = null;
/** Sounds go through a category bus (card effects / interface / music), each with its own volume, then the master. */
export type SoundBus = "fx" | "ui" | "music";
export const BUS_KEY = "duel-sfx-bus";
export let busVol: Record<SoundBus, number> = (() => {
  try { const v = JSON.parse(localStorage.getItem(BUS_KEY) ?? "null"); if (v && typeof v === "object") return { fx: 1, ui: 1, music: 0, ...v }; } catch { /* ignore */ }
  return { fx: 1, ui: 1, music: 0 };   // music starts off
})();
export const buses: Partial<Record<SoundBus, GainNode>> = {};
export let currentBus: SoundBus = "fx";
export const getBusVolume = (b: SoundBus) => busVol[b];
export function setBusVolume(b: SoundBus, v: number) {
  busVol = { ...busVol, [b]: Math.min(1, Math.max(0, v)) };
  try { localStorage.setItem(BUS_KEY, JSON.stringify(busVol)); } catch { /* private mode */ }
  const g = buses[b]; if (g) g.gain.value = busVol[b];
  listeners.forEach((l) => l());
}
/** The node a sound connects to: its category bus (the one `play` is making a sound for). */
export function master(a: AudioContext): GainNode { return bus(a, currentBus); }
export function bus(a: AudioContext, b: SoundBus): GainNode {
  const top = masterOut(a);
  let g = buses[b];
  if (!g || g.context !== a) { g = a.createGain(); g.connect(top); buses[b] = g; }
  g.gain.value = busVol[b];
  return g;
}
export function masterOut(a: AudioContext): GainNode {
  if (!masterGain || masterGain.context !== a) {
    masterGain = a.createGain();
    // a gentle compressor so stacked sounds (a summon + its splash + a chain note) don't clip
    const comp = a.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    masterGain.connect(comp).connect(a.destination);
  }
  masterGain.gain.value = volume * 1.4;   // 0.7 (the default) ~ the original loudness
  return masterGain;
}
export const getVolume = () => volume;
export function setVolume(v: number) {
  volume = Math.min(1, Math.max(0, v));
  try { localStorage.setItem(VOL_KEY, String(volume)); } catch { /* private mode */ }
  if (masterGain) masterGain.gain.value = volume * 1.4;
  listeners.forEach((l) => l());
}
export function setMuted(m: boolean) {
  muted = m;
  try { localStorage.setItem(KEY, m ? "1" : "0"); } catch { /* private mode */ }
  listeners.forEach((l) => l());
}
export function onMuteChange(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

let resuming = false;
// Starting the audio engine takes a few hundred ms on the main thread: do it on the page's first click / key
// (in the lobby, say) instead of in the middle of the first summon's animation.
if (typeof window !== "undefined") {
  const warm = () => { removeEventListener("pointerdown", warm, true); removeEventListener("keydown", warm, true); setTimeout(() => audio(), 0); };
  addEventListener("pointerdown", warm, true);
  addEventListener("keydown", warm, true);
}
export function audio(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  // before the page's first click / key nothing can play: don't build sounds into a silent context (that work
  // and the browser's refusal to start it, every time, were a main-thread cost on every effect)
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return null;
  ctx ??= new AudioContext();
  if (ctx.state === "suspended" && !resuming) {
    resuming = true;
    void ctx.resume().catch(() => undefined).finally(() => { resuming = false; });
  }
  return ctx;
}

// ---------------------------------------------------------------------------------------
// building blocks

/** A shared room reverb (a generated decaying-noise impulse): magical sounds send some of their signal here. */
export let verb: { ctx: AudioContext; input: GainNode } | null = null;
export function reverb(a: AudioContext): GainNode {
  if (verb?.ctx === a) return verb.input;
  const len = Math.floor(a.sampleRate * 2.2);
  const ir = a.createBuffer(2, len, a.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  const conv = a.createConvolver(); conv.buffer = ir;
  const input = a.createGain(); input.gain.value = 0.32;
  input.connect(conv).connect(masterOut(a));   // shared by every category: straight to the master
  verb = { ctx: a, input };
  return input;
}

export interface ToneOpts { type?: OscillatorType; gain?: number; to?: number; attack?: number; wet?: number; detune?: number; pan?: number }
/** One note: oscillator with an attack and exponential decay; `wet` sends it to the reverb. */
export function tone(a: AudioContext, at: number, freq: number, ms: number, o: ToneOpts = {}) {
  const osc = a.createOscillator(), g = a.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(freq, at);
  if (o.detune) osc.detune.value = o.detune;
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, at + ms / 1000);
  const peak = o.gain ?? 0.08;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + (o.attack ?? 0.012));
  g.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
  let out: AudioNode = osc.connect(g);
  if (o.pan) { const p = a.createStereoPanner(); p.pan.value = o.pan; out = out.connect(p); }
  out.connect(master(a));
  if (o.wet) { const w = a.createGain(); w.gain.value = o.wet; out.connect(w).connect(reverb(a)); }
  osc.start(at);
  osc.stop(at + ms / 1000 + 0.05);
}

/** Filtered noise: a swish (bandpass), a thump of air (lowpass) or a hiss (highpass); `sweep` glides the filter. */
export function noise(a: AudioContext, at: number, ms: number, freq: number, gain = 0.06, o: { type?: BiquadFilterType; sweep?: number; q?: number; wet?: number; attack?: number } = {}) {
  const len = Math.max(1, Math.floor(a.sampleRate * ms / 1000));
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  const atk = Math.max(1, Math.floor(len * (o.attack ?? 0)));
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (i < atk ? i / atk : 1 - (i - atk) / (len - atk));
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = buf;
  f.type = o.type ?? "bandpass"; f.Q.value = o.q ?? 0.9;
  f.frequency.setValueAtTime(freq, at);
  if (o.sweep) f.frequency.exponentialRampToValueAtTime(o.sweep, at + ms / 1000);
  g.gain.value = gain;
  const out = src.connect(f).connect(g);
  out.connect(master(a));
  if (o.wet) { const w = a.createGain(); w.gain.value = o.wet; out.connect(w).connect(reverb(a)); }
  src.start(at);
}

/** A low body thump (a sine that drops fast): landings, impacts. */
export const thump = (a: AudioContext, at: number, gain = 0.22, from = 120, ms = 260) => tone(a, at, from, ms, { gain, to: 38, attack: 0.004 });
/** A bell / glass ping: a few inharmonic partials. */
export function bell(a: AudioContext, at: number, f: number, gain = 0.05, ms = 900, wet = 0.5) {
  [[1, 1], [2.76, 0.45], [5.4, 0.2], [8.93, 0.08]].forEach(([k, g]) => tone(a, at, f * k, ms / (k > 2 ? 1.6 : 1), { gain: gain * g, wet, attack: 0.003 }));
}
/** Metallic clang: detuned square partials through a short decay. */
export function clang(a: AudioContext, at: number, f: number, gain = 0.04) {
  [1, 1.47, 2.09, 2.76].forEach((k, i) => tone(a, at, f * k, 420 - i * 60, { type: "square", gain: gain / (i + 1), wet: 0.35, attack: 0.002 }));
  noise(a, at, 60, 4000, 0.05, { type: "highpass" });
}
/** A shimmer: high detuned sines rising slightly. */
export function shimmer(a: AudioContext, at: number, f = 1760, gain = 0.018, ms = 900) {
  for (let i = 0; i < 4; i++) tone(a, at + i * 0.04, f * (1 + i * 0.25), ms, { gain, to: f * (1 + i * 0.25) * 1.06, detune: (i - 1.5) * 9, wet: 0.7, attack: 0.08, pan: (i - 1.5) * 0.35 });
}
/** Quick notes in a row. */
export function arp(a: AudioContext, at: number, freqs: number[], step: number, o: ToneOpts & { ms?: number } = {}) {
  freqs.forEach((f, i) => tone(a, at + i * step, f, o.ms ?? 260, { type: "triangle", gain: 0.045, wet: 0.35, ...o }));
}
export const N = (semi: number) => 440 * Math.pow(2, (semi - 9) / 12);   // semitones from C4 (0 = C4 = 261.6 Hz)

/** Which bus the next sounds go to (play / music set it around each sound). */
export function setBus(b: SoundBus) { currentBus = b; }
