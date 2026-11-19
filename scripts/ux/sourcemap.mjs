// Maps a position in the built client bundle (dist/client/assets/*.js) back to the source file and line, using
// the hidden source maps a UX_SOURCEMAP=1 build writes next to the bundle. Returns null without maps.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SourceMapConsumer } from "source-map-js";

const maps = new Map();
function load(url) {
  const file = url.split("/").pop().split("?")[0];
  if (!maps.has(file)) {
    const js = join("dist/client/assets", file);
    maps.set(file, existsSync(`${js}.map`) ? { js, code: null, map: new SourceMapConsumer(JSON.parse(readFileSync(`${js}.map`, "utf8"))) } : null);
  }
  return maps.get(file);
}

const fmt = (o) => (o.source ? `${o.source.replace(/^.*?((src|node_modules)\/)/, "$1")}:${o.line}${o.name ? ` (${o.name})` : ""}` : null);

/** line / column, both 1-based line and 0-based column (source-map convention). */
export function sourceAt(url, line, column) {
  try { const m = load(url); return m ? fmt(m.map.originalPositionFor({ line, column })) : null; } catch { return null; }
}

/** A character offset into the bundle (what Long Animation Frames report). */
export function sourceAtChar(url, pos) {
  try {
    const m = load(url);
    if (!m || pos == null || pos < 0) return null;
    m.code ??= readFileSync(m.js, "utf8");
    const before = m.code.slice(0, pos);
    return fmt(m.map.originalPositionFor({ line: before.split("\n").length, column: pos - before.lastIndexOf("\n") - 1 }));
  } catch { return null; }
}

export const isSource = (s) => /^(src|node_modules)\//.test(s ?? "");
