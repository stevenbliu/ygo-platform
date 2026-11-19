// Per-browser duel preferences (the ⚙ panel in a duel): 3D tilt, what the board shows, confirmations.
import { useSyncExternalStore } from "react";

export interface DuelSettings {
  /** 3D view: how far the table tilts away from you, in degrees (0 = flat). */
  tilt: number;
  /** ATK / DEF under face-up monsters. */
  stats: boolean;
  /** Battle outcome on each target while choosing an attack target. */
  matchup: boolean;
  /** Ask before ending the turn with an unused Normal Summon. */
  confirmEnd: boolean;
  /** Field and hand size multipliers (1 = fitted to the window). */
  fieldScale: number;
  handScale: number;
  /** Put summoned / set cards in a zone by itself (Extra Monster Zone first, then the middle) instead of asking. */
  autoPlace: boolean;
  /** Battle Phase: drag your monster onto an opponent's monster to attack it. */
  dragAttack: boolean;
  /** Side panels fade while the mouse is away from them. */
  calmPanels: boolean;
  /** Animations: how the card whose effect is resolving is marked, and in what colour. */
  resolveFx: ResolveFx;
  resolveColor: ResolveColor;
  /** Summons and activations: "full" (signature effects + card-art splash), "short" (effects, a quicker
   *  splash), "off" (a plain glow). */
  summonFx: SummonFxMode;
  /** Animation speed: 1 (normal), 1.5, 2. */
  animSpeed: number;
  /** Interface size on a scaled duel: "auto" keeps text readable on small windows; the others pick the layout's
   *  design width (smaller = everything bigger). */
  uiSize: UiSize;
  /** Blue / orange instead of green / red and the you-vs-opponent colours (colour-blind friendly). */
  colorblind: boolean;
  /** How the card itself is shown before its summon, and before its activation (different on purpose). */
  summonSplash: SplashStyle;
  activateSplash: SplashStyle;
  /** The big "CHAIN?" / "YOUR MOVE" callouts. */
  callouts: boolean;
  /** Red / green / accent flashes around the screen edge (damage, heals, callouts). */
  edgeFlash: boolean;
  /** The light running across the zone labels. */
  labelShimmer: boolean;
  /** The turn sign's heartbeat. */
  heartbeat: boolean;
  /** Layout: field up / down (in card widths, negative = up). */
  fieldY: number;
  /** 3D camera distance in px (bigger = flatter, the far side shrinks less). */
  camera: number;
  /** 3D camera height: where you look from, % of the board height (100 = from your edge). */
  cameraY: number;
  /** How far your hand sits below the board edge (% of a card; lower = more of it shows). */
  handDrop: number;
  /** How far the opponent's hand sits above the board edge (% of a card). */
  oppHandDrop: number;
  /** Opponent's hand card size multiplier. */
  oppHandScale: number;
  /** Size of the big card preview shown while you hover a card. */
  previewScale: number;
}
export const RESOLVE_FX = ["rings", "sparkle", "fireworks", "aura", "powerup", "holy", "void", "electric", "circle", "frost", "minimal"] as const;
export type ResolveFx = (typeof RESOLVE_FX)[number];
export const RESOLVE_FX_LABEL: Record<ResolveFx, string> = { rings: "Shockwave rings", sparkle: "Sparkles", fireworks: "Fireworks", aura: "Flame aura", powerup: "Power-up aura (energy + lightning)", holy: "Holy light (pillar + halo)", void: "Dark vortex", electric: "Electric current", circle: "Summoning circle", frost: "Frost crystals", minimal: "Minimal outline" };
export const SPLASH_STYLES = ["showcase", "portal", "banner", "cutin", "hologram", "comic", "spotlight", "manga", "slash", "popart", "stamp", "film", "brush"] as const;
export type SplashStyle = (typeof SPLASH_STYLES)[number];
export const SPLASH_STYLE_LABEL: Record<SplashStyle, string> = {
  showcase: "Showcase (the card rises out of its zone)", portal: "Portal (its art opens over the zone)", banner: "Banner (its art sweeps across the board)",
  cutin: "Cut-in (an art panel bursts in from the screen edge)", hologram: "Hologram (projected above the card)",
  comic: "Comic (a starburst panel)", spotlight: "Spotlight (the room dims, the card rises into the light)",
  manga: "Manga (three panels slam in)", slash: "Double slash (two blade cuts, the name in the gap)", popart: "Pop art (four colour tiles, a ransom-note name)",
  stamp: "Stamp (slammed down with an ink burst)", film: "Film strip (frames race across, one holds)", brush: "Ink brush (one stroke sweeps the art across)",
};
export const ANIM_SPEEDS = [1, 1.5, 2];
export const UI_SIZES = ["auto", "compact", "medium", "large", "xl"] as const;
export type UiSize = (typeof UI_SIZES)[number];
export const UI_SIZE_LABEL: Record<UiSize, string> = { auto: "Auto (readable on small windows)", compact: "Compact (full layout)", medium: "Medium", large: "Large", xl: "Extra large" };
export const SUMMON_FX = ["full", "short", "off"] as const;
export type SummonFxMode = (typeof SUMMON_FX)[number];
export const SUMMON_FX_LABEL: Record<SummonFxMode, string> = { full: "Full (effects + card art splash)", short: "Short (a quicker card art splash)", off: "Off (a simple glow)" };
export const RESOLVE_COLORS = ["theme", "gold", "crimson", "azure", "emerald", "rainbow"] as const;
export type ResolveColor = (typeof RESOLVE_COLORS)[number];
export const RESOLVE_COLOR_LABEL: Record<ResolveColor, string> = { theme: "Theme colour", gold: "Gold", crimson: "Crimson", azure: "Azure", emerald: "Emerald", rainbow: "Rainbow" };

/** Slider ranges / defaults for the layout settings. */
export const LAYOUT = {
  fieldY: { min: -1.5, max: 1.5, step: 0.05, def: 0.45 },
  camera: { min: 700, max: 4000, step: 50, def: 1450 },
  cameraY: { min: 0, max: 150, step: 5, def: 80 },
  handDrop: { min: 10, max: 85, step: 1, def: 44 },
  oppHandDrop: { min: 10, max: 95, step: 1, def: 24 },
  oppHandScale: { min: 0.6, max: 1.8, step: 0.05, def: 1.15 },
  previewScale: { min: 0.6, max: 2, step: 0.05, def: 1 },
} as const;
export type LayoutKey = keyof typeof LAYOUT;
export const SCALE_RANGE = { field: [0.8, 1.6], hand: [0.8, 2.0] } as const;
export const TILT_MAX = 60;
/** Defaults: a big field and hand (the "middle" setting; the sliders go both ways). */
export const DEFAULT_SCALE = { field: 1.25, hand: 1.2 } as const;
export const DEFAULT_TILT = 28;
const DEFAULTS: DuelSettings = { tilt: DEFAULT_TILT, stats: true, matchup: true, confirmEnd: true, fieldScale: DEFAULT_SCALE.field, handScale: DEFAULT_SCALE.hand, autoPlace: true, dragAttack: true, calmPanels: true,
  resolveFx: "rings", resolveColor: "theme", summonFx: "full", animSpeed: 1, uiSize: "auto", colorblind: false, summonSplash: "showcase", activateSplash: "portal", callouts: true, edgeFlash: true, labelShimmer: true, heartbeat: true,
  ...(Object.fromEntries(Object.entries(LAYOUT).map(([k, v]) => [k, v.def])) as Record<LayoutKey, number>) };
const KEY = "ygo.duelSettings";

function load(): DuelSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<DuelSettings> | null;
    // the old on/off 3D switch
    const legacyOff = localStorage.getItem("ygo.tilt") === "off";
    const s = { ...DEFAULTS, ...(legacyOff ? { tilt: 0 } : {}), ...(raw ?? {}) };
    const clamp = (v: unknown, [lo, hi]: readonly [number, number], d: number) => Math.min(hi, Math.max(lo, Number(v) || d));
    for (const k of Object.keys(LAYOUT) as LayoutKey[]) {
      const r = LAYOUT[k], v = Number(s[k]);
      s[k] = Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, v)) : r.def;
    }
    if (!(RESOLVE_FX as readonly string[]).includes(s.resolveFx)) s.resolveFx = DEFAULTS.resolveFx;
    if (!(RESOLVE_COLORS as readonly string[]).includes(s.resolveColor)) s.resolveColor = DEFAULTS.resolveColor;
    if (!(SUMMON_FX as readonly string[]).includes(s.summonFx)) s.summonFx = DEFAULTS.summonFx;
    if (!ANIM_SPEEDS.includes(Number(s.animSpeed))) s.animSpeed = DEFAULTS.animSpeed;
    if (!(UI_SIZES as readonly string[]).includes(s.uiSize)) s.uiSize = DEFAULTS.uiSize;
    if (!(SPLASH_STYLES as readonly string[]).includes(s.summonSplash)) s.summonSplash = DEFAULTS.summonSplash;
    if (!(SPLASH_STYLES as readonly string[]).includes(s.activateSplash)) s.activateSplash = DEFAULTS.activateSplash;
    return { ...s, tilt: Math.min(TILT_MAX, Math.max(0, Number(s.tilt) || 0)), fieldScale: clamp(s.fieldScale, SCALE_RANGE.field, DEFAULT_SCALE.field), handScale: clamp(s.handScale, SCALE_RANGE.hand, DEFAULT_SCALE.hand) };
  } catch { return DEFAULTS; }
}

let current: DuelSettings = typeof window === "undefined" ? DEFAULTS : load();
const listeners = new Set<() => void>();

export function setDuelSetting<K extends keyof DuelSettings>(k: K, v: DuelSettings[K]) {
  current = { ...current, [k]: v };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* storage blocked */ }
  listeners.forEach((l) => l());
}
export const duelSettings = () => current;
export function useDuelSettings(): DuelSettings {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current, () => DEFAULTS);
}
