// DuelPage: the floating card preview. Hovering a card (board, hand or log) shows it, on the side away from
// the pointer; the wheel scrolls its text while you point at a card; a long-press (touch) opens the big view.
import { useCallback, useEffect, useRef, useState } from "react";
import { scrollableAncestor } from "../DuelParts.tsx";

export function useHoverPreview(setZoomCard: (code: number) => void) {
  const [preview, setPreview] = useState<number | null>(null);
  const [hovering, setHovering] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // the preview always floats on the left (it used to jump to the side away from the pointer: restless)
  // for the Z (zoom) key: what's hovered right now
  const hoveringRef = useRef(false), previewRef = useRef<number | null>(null);
  hoveringRef.current = hovering;
  previewRef.current = preview;
  const onHoverCard = useCallback((code: number | null) => {
    clearTimeout(hoverTimer.current);
    if (code) { setPreview(code); setHovering(true); }
    else hoverTimer.current = setTimeout(() => setHovering(false), 350);
  }, []);
  /** A card named in the log: the same floating preview as a card on the field, in the spot it last used. */
  const onLogCard = useCallback((code: number | null) => {
    clearTimeout(hoverTimer.current);
    if (code) { setPreview(code); setHovering(true); }
    else hoverTimer.current = setTimeout(() => setHovering(false), 350);
  }, []);

  // while you point at a card, the mouse wheel scrolls its text in the preview (no need to move over there)
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!hoveringRef.current || e.ctrlKey) return;
      // only while pointing at a card on the board / in a hand: anywhere that scrolls itself (the log,
      // the dock's chain list, a picker, the settings) keeps the wheel for its own scrolling
      const target = e.target as HTMLElement;
      if (!target.closest?.(".duel-board-wrap .duel-card, .duel-hand .duel-card")) return;
      if (scrollableAncestor(target)) return;
      const el = document.querySelector<HTMLElement>(".duel-floatpreview.is-shown .duel-preview-text");
      if (!el || el.scrollHeight <= el.clientHeight + 2 || el.contains(target)) return;
      el.scrollTop += e.deltaY;
      e.preventDefault();
    };
    // the fade at the bottom of the text goes away once you've reached the end
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement;
      if (el.classList?.contains("duel-preview-text")) el.classList.toggle("is-end", el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
    };
    addEventListener("wheel", onWheel, { passive: false });
    addEventListener("scroll", onScroll, true);
    return () => { removeEventListener("wheel", onWheel); removeEventListener("scroll", onScroll, true); };
  }, []);

  // long-press on a card (touch) opens the big preview
  useEffect(() => {
    const onInspect = (e: Event) => { const code = (e as CustomEvent<number>).detail; if (code > 0) { setPreview(code); setZoomCard(code); } };
    addEventListener("duel-inspect", onInspect);
    return () => removeEventListener("duel-inspect", onInspect);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { preview, setPreview, hovering, onHoverCard, onLogCard, hoveringRef, previewRef };
}
