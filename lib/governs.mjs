import { expandBraces } from "./agents.mjs";
import { parseFrontmatter, text } from "./docs.mjs";

const DECISION_FILE = /^docs\/decisions\/(\d{4})-[^/]+\.md$/;

const segment = (glob) => new RegExp(`^${glob.split("*").map((s) => s.replace(/[.+^${}()|[\]\\?]/g, "\\$&")).join("[^/]*")}$`);

function matchSegments(glob, path) {
  if (!glob.length) return !path.length;
  if (glob[0] === "**") {
    if (glob.length === 1) return path.length > 0;
    return matchSegments(glob.slice(1), path) || (path.length > 0 && matchSegments(glob, path.slice(1)));
  }
  return path.length > 0 && segment(glob[0]).test(path[0]) && matchSegments(glob.slice(1), path.slice(1));
}

export function matchesGlob(glob, path) {
  return expandBraces(glob).some((g) => matchSegments(g.split("/"), path.split("/")));
}

export function governingDecisions(files, read) {
  const out = [];
  for (const path of files) {
    const n = path.match(DECISION_FILE)?.[1];
    if (!n) continue;
    const src = text(read(path));
    const fm = src === null ? null : parseFrontmatter(src);
    const { type, status, governs } = fm?.data ?? {};
    if (type !== "decision" || status !== "accepted" || !Array.isArray(governs)) continue;
    const h1 = src.split("\n").slice(fm.end + 1).find((l) => l.startsWith("# "));
    const title = h1 ? h1.slice(2).trim().replace(/^\d+\s+/, "") : "";
    out.push({ number: n, title, path, governs });
  }
  return out.sort((a, b) => Number(a.number) - Number(b.number));
}

export function which(paths, decisions) {
  return paths.map((path) => ({ path, decisions: decisions.filter((d) => d.governs.some((g) => matchesGlob(g, path))) }));
}
