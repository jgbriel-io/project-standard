#!/usr/bin/env node
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkAgentsCap, checkDrift, sync } from "./lib/agents.mjs";
import { checkDecisions, checkFrontmatter, checkLinks } from "./lib/docs.mjs";
import { checkGitleaks } from "./lib/gitleaks.mjs";
import { changes, listFiles, reader, repoRoot, resolveBase } from "./lib/git.mjs";
import { governingDecisions, which } from "./lib/governs.mjs";

const USAGE = `usage:
  project-standard sync                                   regenerate the Cursor, Codex and Kiro copies
  project-standard check (--staged | --base <ref> | --all)
  project-standard which <path...>                        list the accepted decisions that govern each path`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { staged: { type: "boolean" }, base: { type: "string" }, all: { type: "boolean" } },
});
const root = repoRoot();

if (positionals[0] === "sync") {
  const { errors, written, removed } = sync(root);
  for (const e of errors) console.error(`${e.path}: ${e.message}`);
  for (const p of written) console.log(`wrote   ${p}`);
  for (const p of removed) console.log(`removed ${p}`);
  process.exit(errors.length ? 1 : 0);
}

if (positionals[0] === "which" && positionals.length > 1) {
  const paths = positionals.slice(1).map((p) => relative(root, resolve(p)).replaceAll("\\", "/"));
  const decisions = governingDecisions(listFiles(root, { untracked: true }), reader(root, false));
  for (const { path, decisions: found } of which(paths, decisions)) {
    if (!found.length) console.log(`${path}: none`);
    for (const d of found) console.log(`${path}: ${d.number} ${d.title}`);
  }
  process.exit(0);
}

const modes = [values.staged, values.base !== undefined, values.all].filter(Boolean).length;
if (positionals[0] !== "check" || modes !== 1) {
  console.error(USAGE);
  process.exit(2);
}

const scope = values.staged ? { kind: "staged" } : values.all ? { kind: "all" } : { kind: "base", base: resolveBase(root, values.base) };
const read = reader(root, scope.kind === "staged");
const tracked = listFiles(root);
const diff = changes(root, scope);
const findings = [
  ...checkFrontmatter(diff, read),
  ...checkLinks(diff, new Set(tracked), read),
  ...checkDecisions(diff, tracked, read),
  ...checkAgentsCap(tracked, read),
  ...checkDrift(tracked, read),
  ...(await checkGitleaks(root, scope)),
];
for (const f of findings) console.log(`${f.path}:${f.line}: [${f.check}] ${f.message}`);
if (findings.length) console.error(`project-standard: ${findings.length} finding(s)`);
process.exit(findings.length ? 1 : 0);
