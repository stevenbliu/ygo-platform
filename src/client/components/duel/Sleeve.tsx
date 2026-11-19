// Card sleeves on screen: the back of a card in the sleeve its owner picked for their deck.
// A design is a class on .duel-card-back (colours + a pattern, sleeves.css); an art sleeve is the
// card's artwork in a frame. The duel page provides each seat's sleeve through SleeveContext.
import { createContext, useContext, type CSSProperties } from "react";
import { cardImage } from "../../api.ts";
import { SLEEVE_DESIGNS, cleanSleeve } from "../../../shared/sleeves.ts";
import { CARD_BACK_SVG, SCENE_FRAME_SVG, SLEEVE_FRAME_SVG } from "./cardBack.ts";
import "./sleeves.css";

/** owner seat -> that player's sleeve (unset = the classic back). */
export const SleeveContext = createContext<(owner: 0 | 1 | undefined) => string | undefined>(() => undefined);
export const useSleeve = (owner: 0 | 1 | undefined) => useContext(SleeveContext)(owner);

/** Class, style and inner markup of a sleeve's back (also used by the deck builder's previews). */
export function sleeveParts(raw: string | undefined): { className: string; style?: CSSProperties; html: string } {
  const s = cleanSleeve(raw);
  if (s.startsWith("art:") || s.startsWith("scene:")) {
    const scene = s.startsWith("scene:");
    const url = `url("${cardImage(Number(s.slice(s.indexOf(":") + 1)), "crop")}")`;
    return { className: scene ? "sl-art sl-scene" : "sl-art", style: { "--sl-art": url } as CSSProperties, html: `<span class="sl-art-img"></span>${scene ? SCENE_FRAME_SVG : SLEEVE_FRAME_SVG}` };
  }
  const id = s.slice(7);
  const scene = SLEEVE_DESIGNS.find((d) => d.id === id)?.kind === "scene";
  return { className: `sl-${id}${scene ? " sl-painted" : ""}`, html: scene ? `<span class="sl-paint"></span>${SCENE_FRAME_SVG}` : CARD_BACK_SVG };
}

export function SleeveBack({ sleeve, className = "" }: { sleeve?: string; className?: string }) {
  const p = sleeveParts(sleeve);
  return <div className={`duel-card-back ${p.className} ${className}`} style={p.style} role="img" aria-label="Face-down card" dangerouslySetInnerHTML={{ __html: p.html }} />;
}
