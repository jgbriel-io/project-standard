#!/usr/bin/env node
/** Self-test for the shared check and the generator. Builds throwaway git repos in the temp dir.
 *
 *     node test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgentsCap, checkDrift, expandBraces, sync } from "./lib/agents.mjs";
import { checkDecisions, checkFrontmatter, checkLinks, parseFrontmatter } from "./lib/docs.mjs";
import { checkGitleaks } from "./lib/gitleaks.mjs";
import { changes, listFiles, reader, resolveBase } from "./lib/git.mjs";
import { governingDecisions, matchesGlob, which } from "./lib/governs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const roots = [];
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

function write(root, files) {
  for (const [p, content] of Object.entries(files)) {
    if (content === null) rmSync(join(root, p));
    else {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), content);
    }
  }
}

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "project-standard-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  git(root, "config", "core.autocrlf", "false");
  write(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", "base");
  return root;
}

function stage(root, files) {
  write(root, files);
  git(root, "add", "-A");
}

function run(root, kind, base) {
  const scope = kind === "base" ? { kind, base: resolveBase(root, base) } : { kind };
  const read = reader(root, kind === "staged");
  const tracked = listFiles(root);
  const diff = changes(root, scope);
  return [
    ...checkFrontmatter(diff, read),
    ...checkLinks(diff, new Set(tracked), read),
    ...checkDecisions(diff, tracked, read),
    ...checkAgentsCap(tracked, read),
    ...checkDrift(tracked, read),
  ];
}

const messages = (findings) => findings.map((f) => `${f.path}:${f.line}: [${f.check}] ${f.message}`);
const doc = (type, status, extra = "") => `---\ntype: ${type}\nstatus: ${status}\n${extra}---\n# Title\n`;
const decision = (n, status = "accepted", extra = "") => `---\ntype: decision\nstatus: ${status}\nnumber: ${n}\ndate: 2026-09-28\nsuperseded_by:\n${extra}---\n# ${n}\n`;
const governed = (n, status, globs, title = `Decision ${n}`) => decision(n, status, `governs:\n${globs.map((g) => `  - "${g}"\n`).join("")}`).replace(`# ${n}\n`, `# ${String(n).padStart(4, "0")} ${title}\n`);

// Frontmatter parser: empty value is null, block and inline lists, anything else is reported.
{
  const fm = parseFrontmatter("---\nsuperseded_by:\nlabels: [domain:a, 'domain:b']\ndepends_on:\n  - 3\n  - 4\ntitle: \"A: B\"\n---\nbody");
  assert.equal(fm.data.superseded_by, null);
  assert.deepEqual(fm.data.labels, ["domain:a", "domain:b"]);
  assert.deepEqual(fm.data.depends_on, ["3", "4"]);
  assert.equal(fm.data.title, "A: B");
  assert.equal(parseFrontmatter("---\n{ nope }\n---\n").errors.length, 1);
  assert.equal(parseFrontmatter("# no frontmatter"), null);
}

// Frontmatter check on changed docs only; archive is exempt; an unmigrated file elsewhere never blocks.
{
  const root = repo({ "docs/legacy.md": "# no frontmatter, untouched\n" });
  stage(root, {
    "docs/product/vision.md": "# no frontmatter\n",
    "docs/product/scope.md": doc("product", "live"),
    "docs/archive/old.md": "# moved unchanged\n",
    "docs/decisions/0001-a.md": decision(2, "superseded"),
  });
  const found = messages(run(root, "staged")).join("\n");
  assert.match(found, /vision\.md:1: \[frontmatter\] missing frontmatter/);
  assert.match(found, /scope\.md:3: \[frontmatter\] status live/);
  assert.match(found, /0001-a\.md:4: \[frontmatter\] number 2 does not match/);
  assert.match(found, /0001-a\.md:6: \[frontmatter\] a superseded decision needs superseded_by/);
  assert.doesNotMatch(found, /legacy\.md|docs\/archive\//);
}

// Links resolve against tracked files with exact case; untracked, wikilinks and escapes fail; code is skipped.
{
  const root = repo({
    "docs/product/visão geral.md": doc("product", "current"),
    "docs/product/guide.md": doc("product", "current"),
    "src/app.ts": "",
  });
  stage(root, {
    "docs/README.md": [
      doc("index", "current"),
      "[ok](product/guide.md#setup) [dir](../src) [root](/src/app.ts) [web](https://x.dev) [anchor](#top)",
      "[encoded](product/vis%C3%A3o%20geral.md) [angled](<product/visão geral.md>)",
      "[case](product/Guide.md) [untracked](product/untracked.md) [out](../../x.md) [[wiki]]",
      "`[code](nope.md)`",
      "```",
      "[fenced](nope.md)",
      "```",
    ].join("\n"),
  });
  write(root, { "docs/product/untracked.md": "x" });
  const found = messages(run(root, "staged"));
  assert.equal(found.length, 4, found.join("\n"));
  assert.match(found.join("\n"), /product\/Guide\.md does not resolve/);
  assert.match(found.join("\n"), /product\/untracked\.md does not resolve/);
  assert.match(found.join("\n"), /\.\.\/\.\.\/x\.md leaves the repository/);
  assert.match(found.join("\n"), /\[\[wiki\]\] is a wikilink/);
}

// A removal reports only links to the removed file, never an old broken link elsewhere.
{
  const root = repo({
    "docs/a.md": `${doc("product", "current")}[b](b.md)\n`,
    "docs/b.md": doc("product", "current"),
    "docs/c.md": `${doc("product", "current")}[old](gone-long-ago.md)\n`,
  });
  git(root, "rm", "-q", "docs/b.md");
  const found = messages(run(root, "staged"));
  assert.deepEqual(found, ["docs/a.md:6: [links] b.md points at a file this change removes"]);
}

// Decisions: contiguous numbers, one index row per file, row status matching the file.
{
  const index = (rows) => `${doc("index", "current")}\n| # | Date | Title | Status |\n|---|---|---|---|\n${rows.join("\n")}\n`;
  const root = repo({});
  stage(root, {
    "docs/decisions/0001-first.md": decision(1),
    "docs/decisions/0003-third.md": decision(3, "rejected"),
    "docs/decisions/0004-Bad_Name.md": decision(4),
    "docs/decisions/README.md": index([
      "| 0001 | 2026-09-28 | [First](0001-first.md) | accepted |",
      "| 0001 | 2026-09-28 | [First again](0001-first.md) | accepted |",
      "| 0003 | 2026-09-28 | [Third](0003-third.md) | accepted |",
    ]),
  });
  const found = messages(run(root, "staged").filter((f) => f.check === "decisions")).join("\n");
  assert.match(found, /0004-Bad_Name\.md:1: \[decisions\] decision files are named/);
  assert.match(found, /README\.md:1: \[decisions\] decision 0002 is missing/);
  assert.match(found, /README\.md:\d+: \[decisions\] second row for 0001-first\.md/);
  assert.match(found, /row status accepted differs from 0003-third\.md, which is rejected/);

  const clean = repo({});
  stage(clean, {
    "docs/decisions/0001-first.md": decision(1),
    "docs/decisions/0002-second.md": decision(2, "superseded", "").replace("superseded_by:\n", "superseded_by: 1\n"),
    "docs/decisions/README.md": index([
      "| 0001 | 2026-09-28 | [First](0001-first.md) | accepted |",
      "| 0002 | 2026-09-28 | [Second](0002-second.md) | superseded |",
    ]),
  });
  assert.deepEqual(messages(run(clean, "staged")), []);
}

// AGENTS.md cap counts real imports and path-less rules; package names and emails are not imports.
{
  const lines = (n) => `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`;
  const root = repo({
    "AGENTS.md": `${lines(150)}See @docs/engineering/more.md, @t3-oss/env-core and dev@example.invalid.\n`,
    "docs/engineering/more.md": `${lines(20)}back to @../../AGENTS.md\n`,
    ".claude/rules/always.md": lines(10),
    ".claude/rules/scoped.md": `---\npaths:\n  - "src/**/*.ts"\n---\n${lines(500)}`,
  });
  assert.deepEqual(checkAgentsCap(listFiles(root), reader(root, false)), []);
  write(root, { ".claude/rules/always.md": lines(40) });
  git(root, "add", "-A");
  const [cap] = checkAgentsCap(listFiles(root), reader(root, false));
  assert.match(cap.message, /^212 lines/);

  const imported = repo({ "AGENTS.md": "@.claude/rules/always.md\n", ".claude/rules/always.md": lines(150) });
  assert.deepEqual(checkAgentsCap(listFiles(imported), reader(imported, false)), []);
}

// Two rules that flatten to the same generated name are an error, never a silent overwrite.
{
  const root = repo({ ".claude/rules/db/migrations.md": "# a\n", ".claude/rules/db-migrations.md": "# b\n" });
  assert.match(sync(root).errors.map((e) => e.message).join("\n"), /same file name as \.claude\/rules\//);
}

assert.deepEqual(expandBraces("src/**/*.{ts,tsx}"), ["src/**/*.ts", "src/**/*.tsx"]);
assert.deepEqual(expandBraces("{a,b}/{c,d}"), ["a/c", "a/d", "b/c", "b/d"]);

// Generator: sync writes the copies, check passes, a hand edit and an orphan fail, sync repairs both.
{
  const mcp = {
    mcpServers: {
      sonarqube: { command: "docker", args: ["run", "-i", "--rm", "-e", "SONARQUBE_TOKEN", "sonarsource/sonarqube-mcp"], env: { SONARQUBE_TOKEN: "${SONARQUBE_TOKEN}", MODE: "ci" } },
      remote: { type: "http", url: "https://mcp.example.invalid/mcp", headers: { Authorization: "Bearer ${REMOTE_TOKEN}", "X-Region": "us" } },
      serena: { command: "serena", args: ["start-mcp-server", "--context", "claude-code"] },
    },
  };
  const root = repo({
    ".mcp.json": JSON.stringify(mcp, null, 2),
    ".claude/rules/db/migrations.md": "---\npaths:\n  - \"db/**/*.{sql,ts}\"\ndescription: Migration rules\n---\n\n# Migrations\n",
    ".claude/rules/general.md": "# Always\n",
    ".claude/skills/demo-skill/SKILL.md": "---\nname: demo-skill\ndescription: demo\n---\nBody\n",
    ".cursor/rules/hand-written.mdc": "stale\n",
  });
  const { written, removed, errors } = sync(root);
  assert.deepEqual(errors, []);
  assert.deepEqual(removed, [".cursor/rules/hand-written.mdc"]);
  assert.equal(written.length, 9);

  const cursor = JSON.parse(readFileSync(join(root, ".cursor/mcp.json"), "utf8")).mcpServers;
  assert.equal(cursor.sonarqube.type, "stdio");
  assert.equal(cursor.sonarqube.env.SONARQUBE_TOKEN, "${env:SONARQUBE_TOKEN}");
  assert.equal(cursor.remote.headers.Authorization, "Bearer ${env:REMOTE_TOKEN}");
  assert.equal(cursor.remote.type, undefined);
  const kiro = JSON.parse(readFileSync(join(root, ".kiro/settings/mcp.json"), "utf8")).mcpServers;
  assert.equal(kiro.sonarqube.env.SONARQUBE_TOKEN, "${SONARQUBE_TOKEN}");
  const codex = readFileSync(join(root, ".codex/config.toml"), "utf8");
  assert.match(codex, /\[mcp_servers\.sonarqube\]\ncommand = "docker"\nargs = \[.*\]\nenv_vars = \["SONARQUBE_TOKEN"\]\nenv = \{ MODE = "ci" \}/);
  assert.match(codex, /bearer_token_env_var = "REMOTE_TOKEN"\nhttp_headers = \{ X-Region = "us" \}/);
  assert.match(codex, /args = \["start-mcp-server", "--context", "codex"\]/);
  assert.deepEqual(cursor.serena.args, ["start-mcp-server", "--context", "ide"]);
  assert.deepEqual(kiro.serena.args, ["start-mcp-server", "--context", "ide"]);
  const mdc = readFileSync(join(root, ".cursor/rules/db-migrations.mdc"), "utf8");
  assert.match(mdc, /^---\ndescription: Migration rules\nglobs: db\/\*\*\/\*\.sql,db\/\*\*\/\*\.ts\nalwaysApply: false\n---\n<!-- Generated/);
  assert.match(readFileSync(join(root, ".cursor/rules/general.mdc"), "utf8"), /^---\nalwaysApply: true\n---\n/);
  assert.match(readFileSync(join(root, ".kiro/steering/db-migrations.md"), "utf8"), /^---\ninclusion: fileMatch\nfileMatchPattern: \["db\/\*\*\/\*\.sql","db\/\*\*\/\*\.ts"\]\n---\n/);
  assert.equal(readFileSync(join(root, ".kiro/skills/demo-skill/SKILL.md"), "utf8"), readFileSync(join(root, ".claude/skills/demo-skill/SKILL.md"), "utf8"));

  git(root, "add", "-A");
  assert.deepEqual(messages(run(root, "staged")), []);
  git(root, "commit", "-q", "-m", "sync");

  stage(root, { ".cursor/mcp.json": "{}\n", ".kiro/steering/orphan.md": "x\n" });
  const found = messages(run(root, "staged")).join("\n");
  assert.match(found, /\.cursor\/mcp\.json:1: \[drift\] differs from its source/);
  assert.match(found, /\.kiro\/steering\/orphan\.md:1: \[drift\] has no source/);

  assert.deepEqual(sync(root).removed, [".kiro/steering/orphan.md"]);
  write(root, { ".cursor/mcp.json": readFileSync(join(root, ".cursor/mcp.json"), "utf8").replace(/\n/g, "\r\n") });
  git(root, "add", "-A");
  assert.deepEqual(messages(run(root, "staged")), []);
  assert.deepEqual(sync(root).written, []);

  write(root, { ".mcp.json": JSON.stringify({ mcpServers: { x: { command: "a", args: ["${TOKEN:-none}"] } } }) });
  assert.match(sync(root).errors[0].message, /server x: \$\{VAR:-default\} is not portable/);
  write(root, { ".mcp.json": JSON.stringify({ mcpServers: { x: { command: "a", args: ["--token=${TOKEN}"] } } }) });
  assert.match(sync(root).errors.map((e) => e.message).join("\n"), /cannot expand|expands \$\{VAR\} only/);
}

// Codex hook: sync renders .codex/hooks.json only while a decision carries governs, with the lockfile's runner; drift catches an edit, a deletion and an orphan.
{
  const hooks = (exec) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: "^apply_patch$", hooks: [{ type: "command", command: `${exec} project-standard hook`, commandWindows: `${exec} project-standard hook`, timeout: 10 }] }] } }, null, 2) + "\n";
  const root = repo({ "docs/decisions/0001-one.md": decision(1), "docs/decisions/0002-two.md": decision(2, "accepted", "governs:\n"), "docs/decisions/0003-flow.md": decision(3, "accepted", "governs: []\n"), "docs/decisions/0004-scalar.md": decision(4, "accepted", "governs: src/**\n"), "docs/product/scope.md": doc("product", "current", 'governs: ["src/**"]\n') });
  const drift = () => messages(run(root, "staged").filter((f) => f.check === "drift"));
  assert.deepEqual(sync(root), { errors: [], written: [], removed: [] });
  assert.deepEqual(drift(), []);
  write(root, { "docs/decisions/0009-draft.md": governed(9, "accepted", ["src/**"]) });
  assert.deepEqual(sync(root).written, []);
  rmSync(join(root, "docs/decisions/0009-draft.md"));

  stage(root, { "docs/decisions/0001-one.md": governed(1, "proposed", ["src/**"]) });
  assert.deepEqual(sync(root), { errors: [], written: [".codex/hooks.json"], removed: [] });
  assert.equal(readFileSync(join(root, ".codex/hooks.json"), "utf8"), hooks("npx --no"));
  assert.deepEqual(sync(root).written, []);
  git(root, "add", "-A");
  assert.deepEqual(drift(), []);
  git(root, "commit", "-q", "-m", "hook");

  stage(root, { ".codex/hooks.json": "{}\n" });
  assert.deepEqual(drift(), [".codex/hooks.json:1: [drift] differs from its source: run project-standard sync (never edit a generated copy)"]);
  assert.deepEqual(sync(root).written, [".codex/hooks.json"]);
  stage(root, { ".codex/hooks.json": hooks("npx --no").replace(/\n/g, "\r\n") });
  assert.deepEqual(drift(), []);

  for (const [lock, exec] of [["bun.lock", "bunx --bun"], ["pnpm-lock.yaml", "pnpm exec"], ["bun.lockb", "bunx --bun"], ["package-lock.json", "npx --no"]]) {
    stage(root, { [lock]: "" });
    assert.deepEqual(drift(), exec === "npx --no" ? [] : [".codex/hooks.json:1: [drift] differs from its source: run project-standard sync (never edit a generated copy)"], lock);
    sync(root);
    assert.equal(readFileSync(join(root, ".codex/hooks.json"), "utf8"), hooks(exec), lock);
    stage(root, { [lock]: null });
    sync(root);
    git(root, "add", "-A");
  }

  git(root, "rm", "-q", "-f", ".codex/hooks.json");
  assert.deepEqual(drift(), [".codex/hooks.json:1: [drift] missing: run project-standard sync and stage the result"]);

  stage(root, { "docs/decisions/0001-one.md": decision(1), ".codex/hooks.json": hooks("npx --no") });
  assert.deepEqual(drift(), [".codex/hooks.json:1: [drift] has no source: run project-standard sync to remove it"]);
  assert.deepEqual(sync(root), { errors: [], written: [], removed: [".codex/hooks.json"] });
  assert.throws(() => readFileSync(join(root, ".codex/hooks.json")), /ENOENT/);
}

// --base: an all-zeros ref (first push of a branch) falls back to HEAD^ instead of failing or scanning everything.
{
  const root = repo({ "docs/a.md": doc("product", "current") });
  write(root, { "docs/b.md": "# no frontmatter\n" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "second");
  const found = messages(run(root, "base", "0000000000000000000000000000000000000000"));
  assert.deepEqual(found, ["docs/b.md:1: [frontmatter] missing frontmatter (type, status)"]);
}

// The CLI runs through its own entry point and exits 1 on a finding: it is never silently a no-op.
{
  const root = repo({ "docs/a.md": "# no frontmatter\n" });
  const cli = spawnSync(process.execPath, [join(here, "cli.mjs"), "check", "--all"], { cwd: root, encoding: "utf8" });
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stdout, /docs\/a\.md:1: \[frontmatter\]/);
  assert.equal(spawnSync(process.execPath, [join(here, "cli.mjs"), "check"], { cwd: root }).status, 2);
}

// Governs matcher: `*` stays in one segment, `**` spans zero or more but a trailing one needs at least one, dots match, case counts.
for (const [glob, path, expected] of [
  ["src/api/**", "src/api/routes/x.ts", true],
  ["src/api/**", "src/api", false],
  ["src/api/*.ts", "src/api/a/b.ts", false],
  ["src/{api,web}/**", "src/web/main.tsx", true],
  ["**/*.yml", ".github/workflows/ci.yml", true],
  ["**/*.ts", "index.ts", true],
  ["db/**/*.sql", "db/x.sql", true],
  ["Src/api/**", "src/api/x.ts", false],
  [".husky/pre-push", ".husky/pre-push", true],
]) {
  assert.equal(matchesGlob(glob, path), expected, `${glob} vs ${path}`);
}

// which: only accepted decisions with governs, ascending, title without its number; the CLI prints them.
{
  const root = repo({
    "docs/decisions/0001-one.md": governed(1, "accepted", ["src/**"]),
    "docs/decisions/0002-two.md": governed(2, "superseded", ["src/**"]),
    "docs/decisions/0003-three.md": governed(3, "proposed", ["src/**"]),
    "docs/decisions/0004-four.md": decision(4),
    "docs/decisions/0010-ten.md": governed(10, "accepted", ["src/{a,b}.ts"]),
    "src/a.ts": "",
  });
  const decisions = governingDecisions(listFiles(root), reader(root, false));
  assert.deepEqual(decisions.map((d) => [d.number, d.title]), [["0001", "Decision 1"], ["0010", "Decision 10"]]);
  assert.deepEqual(which(["src/a.ts", "lib/x.ts"], decisions).map((r) => [r.path, r.decisions.map((d) => d.number)]), [["src/a.ts", ["0001", "0010"]], ["lib/x.ts", []]]);

  const cli = spawnSync(process.execPath, [join(here, "cli.mjs"), "which", "src/a.ts", "README.md"], { cwd: root, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, "src/a.ts: 0001 Decision 1\nsrc/a.ts: 0010 Decision 10\nREADME.md: none\n");
  const nested = spawnSync(process.execPath, [join(here, "cli.mjs"), "which", "a.ts"], { cwd: join(root, "src"), encoding: "utf8" });
  assert.match(nested.stdout, /^src\/a\.ts: 0001 Decision 1\n/);

  const malformed = repo({ "docs/decisions/0001-one.md": decision(1, "accepted", 'governs:\n  - \n  - [a, b]\n  - "src/**"\n'), "src/a.ts": "" });
  assert.deepEqual(which(["src/a.ts"], governingDecisions(listFiles(malformed), reader(malformed, false)))[0].decisions.map((d) => d.number), ["0001"]);
}

// hook: a Claude Code or Codex apply_patch PreToolUse payload on stdin; the repository nearest the edited path decides, it never blocks and never prints on a miss.
{
  const tail = "Read each listed file before continuing; if this change contradicts one, amend or supersede it in this PR.";
  const hook = (cwd, input, env = {}) => {
    const run = spawnSync(process.execPath, [join(here, "cli.mjs"), "hook"], { cwd, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.doesNotMatch(run.stdout, /permissionDecision/);
    return run.stdout;
  };
  const edit = (file_path, cwd) => ({ session_id: "s", cwd, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path, content: "x" } });
  const context = (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });
  const posix = (p) => p.replaceAll("\\", "/");
  const windows = (p) => p.replaceAll("/", "\\");
  const cap = (n) => `docs/decisions/${String(n).padStart(4, "0")}-cap.md`;

  const root = repo({
    "docs/decisions/0001-one.md": governed(1, "accepted", ["src/**"]),
    "docs/decisions/0002-two.md": governed(2, "accepted", ["src/{a,b}.ts"]),
    "docs/decisions/0003-three.md": governed(3, "superseded", ["src/**"]),
    "docs/decisions/0004-four.md": governed(4, "proposed", ["src/**"]),
    ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [cap(11 + i), governed(11 + i, "accepted", ["cap/**"], "T".repeat(500))])),
  });
  const both = context(`Decisions governing src/a.ts: 0001 Decision 1 (docs/decisions/0001-one.md); 0002 Decision 2 (docs/decisions/0002-two.md). ${tail}`);
  assert.equal(hook(root, edit(posix(join(root, "src/a.ts")), root)), both);
  assert.equal(hook(root, edit(windows(join(root, "src/a.ts")), root)), both);
  assert.equal(hook(root, edit(windows(join(root, "src/new/deep/b.ts")), root)), context(`Decisions governing src/new/deep/b.ts: 0001 Decision 1 (docs/decisions/0001-one.md). ${tail}`));
  assert.equal(hook(root, edit("src/a.ts", root)), both);
  assert.equal(hook(root, edit(posix(join(root, "src/..", "src/a.ts")), root)), both);

  const capped = JSON.parse(hook(root, edit(posix(join(root, "cap/x.ts")), root))).hookSpecificOutput.additionalContext;
  assert.ok(capped.length < 1500, String(capped.length));
  assert.equal(capped.match(/\d{4} T/g).length, 5);
  assert.match(capped, /0011 T+… \(docs\/decisions\/0011-cap\.md\); 0012 T+… .+; 0015 T+… \(docs\/decisions\/0015-cap\.md\)\. Read each listed file/);
  assert.equal(hook(root, edit(posix(join(root, "src", "a/".repeat(700), "x.ts")), root)), "");

  assert.equal(hook(root, edit(posix(join(root, "README.md")), root)), "");
  assert.equal(hook(root, edit(posix(join(root, "docs/decisions/0001-one.md")), root)), "");
  assert.equal(hook(root, "{ nope"), "");
  assert.equal(hook(root, ""), "");
  assert.equal(hook(root, { tool_name: "Write", tool_input: {} }), "");
  assert.equal(hook(root, { tool_input: { file_path: 7 } }), "");
  assert.equal(hook(root, "null"), "");

  const outside = mkdtempSync(join(tmpdir(), "project-standard-"));
  roots.push(outside);
  assert.equal(hook(outside, edit(join(outside, "src/a.ts"), outside)), "");
  assert.equal(hook(outside, edit(posix(join(root, "src/a.ts")), outside)), both);

  git(root, "worktree", "add", "-q", "-b", "wt", join(root, "wt"));
  write(join(root, "wt"), { "docs/decisions/0001-one.md": governed(1, "accepted", ["lib/**"]) });
  const env = { CLAUDE_PROJECT_DIR: root };
  assert.equal(hook(root, edit(posix(join(root, "wt/lib/x.ts")), root), env), context(`Decisions governing lib/x.ts: 0001 Decision 1 (docs/decisions/0001-one.md). ${tail}`));
  assert.equal(hook(root, edit(windows(join(root, "wt/src/a.ts")), root), env), context(`Decisions governing src/a.ts: 0002 Decision 2 (docs/decisions/0002-two.md). ${tail}`));
  assert.equal(hook(root, edit(posix(join(root, "wt/README.md")), root), env), "");

  const apply = (command, cwd) => ({ session_id: "s", cwd, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command } });
  const patch = (...lines) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
  const one = (file) => `Decisions governing ${file}: 0001 Decision 1 (docs/decisions/0001-one.md)`;
  const two = (file) => `${one(file)}; 0002 Decision 2 (docs/decisions/0002-two.md)`;
  const multi = patch("*** Add File: src/new.ts", "+*** Add File: README.md", "*** Update File: " + posix(join(root, "src/a.ts")), "*** Move to: src/b.ts", "@@", "-a", "+b", "*** Delete File: README.md");
  assert.equal(hook(root, apply(multi, root)), context(`${one("src/new.ts")}. ${two("src/a.ts")}. ${two("src/b.ts")}. ${tail}`));
  assert.equal(hook(root, apply(multi.replaceAll("\n", "\r\n"), root)), context(`${one("src/new.ts")}. ${two("src/a.ts")}. ${two("src/b.ts")}. ${tail}`));
  assert.equal(hook(root, apply(patch("*** Update File: " + windows(join(root, "src/a.ts")), "@@"), root)), context(`${two("src/a.ts")}. ${tail}`));
  assert.equal(hook(root, apply(patch("*** Update File: a.ts", "*** Add File: b.ts"), join(root, "src"))), context(`${two("src/a.ts")}. ${two("src/b.ts")}. ${tail}`));
  assert.equal(hook(root, apply(patch("*** Add File: src/new.ts", "*** Update File: src/new.ts", "*** Move to: src/new.ts"), root)), context(`${one("src/new.ts")}. ${tail}`));
  assert.equal(hook(root, apply(`apply_patch <<'EOF'\n${patch("*** Add File:  src/new.ts  ")}\nEOF`, root)), context(`${one("src/new.ts")}. ${tail}`));
  assert.equal(hook(root, apply(patch("*** Add File: \t ", "*** Add File: src/new.ts"), root)), context(`${one("src/new.ts")}. ${tail}`));

  const crowded = JSON.parse(hook(root, apply(patch("*** Add File: cap/x.ts", "*** Add File: cap/y.ts", "*** Add File: src/a.ts"), root))).hookSpecificOutput.additionalContext;
  assert.ok(crowded.length < 1500, String(crowded.length));
  assert.equal(crowded.match(/\d{4} T/g).length, 5);
  assert.equal(crowded.match(/Decisions governing/g).length, 2);
  assert.match(crowded, /^Decisions governing cap\/x\.ts: 0011 T.+0015 T.+\(docs\/decisions\/0015-cap\.md\)\. Decisions governing src\/a\.ts: 0001 .+; 0002 /);

  assert.equal(hook(root, apply(patch("*** Add File: README.md", "+*** Add File: src/a.ts", " *** Update File: src/a.ts", "*** Delete File: ../outside.ts"), root)), "");
  assert.equal(hook(root, apply(patch("*** Add File:", "+src/a.ts"), root)), "");
  assert.equal(hook(root, apply("", root)), "");
  assert.equal(hook(root, apply(7, root)), "");
  assert.equal(hook(root, { tool_name: "apply_patch", tool_input: { file_path: posix(join(root, "src/a.ts")) } }), "");
  assert.equal(hook(root, { tool_name: "apply_patch" }), "");
  assert.equal(hook(root, { ...apply(patch("*** Add File: src/a.ts"), root), tool_name: "Bash" }), "");
  assert.equal(hook(outside, apply(patch(`*** Add File: ${posix(join(root, "src/a.ts"))}`, "*** Add File: src/a.ts"), outside)), context(`${two("src/a.ts")}. ${tail}`));
}

{
  const governs = (extra) => decision(1, "accepted", extra);
  const cases = {
    "0001-valid.md": governs('governs:\n  - "src/**"\n  - "src/{a,b}/*.ts"\n  - docs/*.md\n'),
    "0002-flow.md": governs('governs: ["src/{a,b}/**"]\n'),
    "0003-scalar.md": governs('governs: "src/**"\n'),
    "0004-items.md": governs('governs:\n  - "src/?.ts"\n  - "**"\n  - "*"\n  - "src/[ab].ts"\n  - "src/a]"\n  - "src/ok/**"\n  - \n  - [a, b]\n  - ""\n  - " src/** "\n'),
    "0005-empty.md": governs("governs:\n"),
    "0006-absent.md": governs(""),
    "0007-trailing-space.md": governs('governs: \n  - "src/**"\n'),
  };
  const files = Object.fromEntries(Object.entries(cases).map(([name, src], i) => [`docs/decisions/${name}`, src.replace("number: 1", `number: ${i + 1}`)]));
  const root = repo({});
  stage(root, { ...files, "docs/product/scope.md": doc("product", "current", 'governs: ["src/{a,b}/**", "?"]\n'), "docs/product/other.md": doc("spec", "draft", "governs:\n  - \n") });
  const found = messages(run(root, "staged").filter((f) => f.check === "frontmatter"));
  const of = (name) => found.filter((m) => m.startsWith(`docs/decisions/${name}:`));
  const flow = "[frontmatter] governs must be a block list, one \"- glob\" item per line, not a flow list or a scalar";
  assert.deepEqual(of("0001-valid.md"), []);
  assert.deepEqual(of("0002-flow.md"), [`docs/decisions/0002-flow.md:7: ${flow}`]);
  assert.deepEqual(of("0003-scalar.md"), [`docs/decisions/0003-scalar.md:7: ${flow}`]);
  assert.deepEqual(of("0004-items.md"), [
    "governs item 1: ? [ and ] are not supported",
    "governs item 2: a bare * or ** governs everything",
    "governs item 3: a bare * or ** governs everything",
    "governs item 4: ? [ and ] are not supported",
    "governs item 5: ? [ and ] are not supported",
    "governs item 7: must be a non-empty string",
    "governs item 8: must be a non-empty string",
    "governs item 9: must be a non-empty string",
    "governs item 10: has leading or trailing whitespace",
  ].map((m) => `docs/decisions/0004-items.md:7: [frontmatter] ${m}`));
  assert.deepEqual(of("0005-empty.md"), ["docs/decisions/0005-empty.md:7: [frontmatter] governs has no items"]);
  assert.deepEqual(of("0006-absent.md"), []);
  assert.deepEqual(of("0007-trailing-space.md"), []);
  assert.deepEqual(found.filter((m) => m.startsWith("docs/product/")), []);
}

// check --governs warns on dead globs and always exits 0; --base lists the governing decisions, capped at 5 and ascending; --staged lists nothing.
{
  const cli = (root, ...args) => spawnSync(process.execPath, [join(here, "cli.mjs"), ...args], { cwd: root, encoding: "utf8" });
  const commit = (root, files) => {
    stage(root, files);
    git(root, "commit", "-q", "-m", "change");
  };
  const cap = (n) => `docs/decisions/${String(n).padStart(4, "0")}-cap.md`;
  const heading = "Decisions governing this change:";
  const root = repo({
    "docs/decisions/0001-live.md": governed(1, "accepted", ["src/**", "gone/**", "gone/**", "src/{a,gone}.ts"]),
    "docs/decisions/0002-old.md": governed(2, "superseded", ["gone/**"]),
    "docs/decisions/0003-idea.md": governed(3, "proposed", ["src/**", "gone/**"]),
    "docs/decisions/0004-plain.md": decision(4),
    "docs/decisions/0005-lib.md": governed(5, "accepted", ["lib/*.ts"]),
    ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [cap(11 + i), governed(11 + i, "accepted", ["cap/**"])])),
    "src/a.ts": "",
    "cap/seed.ts": "",
    "README.md": "# demo\n",
  });

  const dead = cli(root, "check", "--governs");
  assert.equal(dead.status, 0, dead.stderr);
  assert.equal(dead.stderr, "");
  assert.equal(dead.stdout, ['docs/decisions/0001-live.md:7: [governs] glob "gone/**" matches no tracked file', 'docs/decisions/0005-lib.md:7: [governs] glob "lib/*.ts" matches no tracked file', ""].join("\n"));
  commit(root, { "lib/x.ts": "" });
  assert.equal(cli(root, "check", "--governs").stdout, 'docs/decisions/0001-live.md:7: [governs] glob "gone/**" matches no tracked file\n');
  stage(root, { "gone/x.ts": "" });
  assert.equal(cli(root, "check", "--governs").stdout, 'docs/decisions/0001-live.md:7: [governs] glob "gone/**" matches no tracked file\n');
  git(root, "rm", "-q", "--cached", "gone/x.ts");

  for (const other of [["--staged"], ["--all"], ["--base", "HEAD"], ["--staged", "--all"]]) assert.equal(cli(root, "check", "--governs", ...other).status, 2, other.join(" "));
  assert.equal(cli(root, "--governs").status, 2);

  commit(root, { "cap/x.ts": "", "src/b.ts": "" });
  const listed = cli(root, "check", "--base", "HEAD^");
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, [heading, "0001 Decision 1 (docs/decisions/0001-live.md)", ...[11, 12, 13, 14].map((n) => `00${n} Decision ${n} (${cap(n)})`), ""].join("\n"));

  commit(root, { "README.md": "# demo, edited\n" });
  assert.equal(cli(root, "check", "--base", "HEAD^").stdout, "");

  commit(root, { "src/a.ts": null });
  assert.equal(cli(root, "check", "--base", "HEAD^").stdout, `${heading}\n0001 Decision 1 (docs/decisions/0001-live.md)\n`);

  git(root, "mv", "lib/x.ts", "moved.ts");
  git(root, "commit", "-q", "-m", "rename");
  assert.equal(cli(root, "check", "--base", "HEAD^").stdout, `${heading}\n0005 Decision 5 (docs/decisions/0005-lib.md)\n`);

  commit(root, { "docs/product/x.md": "# no frontmatter\n", "lib/y.ts": "" });
  const failing = cli(root, "check", "--base", "HEAD^");
  assert.equal(failing.status, 1);
  assert.equal(failing.stdout, `docs/product/x.md:1: [frontmatter] missing frontmatter (type, status)\n${heading}\n0005 Decision 5 (docs/decisions/0005-lib.md)\n`);

  stage(root, { "src/c.ts": "", "cap/y.ts": "" });
  const staged = cli(root, "check", "--staged");
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(staged.stdout, "");

  const bare = repo({ "docs/decisions/0001-plain.md": decision(1), "docs/a.md": "# no frontmatter\n", "src/a.ts": "" });
  commit(bare, { "src/b.ts": "" });
  assert.equal(cli(bare, "check", "--governs").stdout, "");
  assert.equal(cli(bare, "check", "--governs").status, 0);
  assert.equal(cli(bare, "check", "--base", "HEAD^").stdout, "");
  assert.equal(cli(bare, "check", "--all").status, 1);
  const none = repo({ "README.md": "# demo\n" });
  assert.deepEqual([cli(none, "check", "--governs").status, cli(none, "check", "--governs").stdout], [0, ""]);

  commit(bare, { "docs/decisions/0002-dead.md": governed(2, "accepted", ["nowhere/**"]) });
  const warned = cli(bare, "check", "--governs");
  assert.deepEqual([warned.status, warned.stdout], [0, 'docs/decisions/0002-dead.md:7: [governs] glob "nowhere/**" matches no tracked file\n']);
  const all = cli(bare, "check", "--all");
  assert.equal(all.status, 1);
  assert.doesNotMatch(all.stdout, /\[governs\]|Decisions governing/);
}

// Gitleaks: a staged token fails the commit, a clean change passes. Downloads the pinned binary once.
{
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const token = `ghp_${[...randomBytes(36)].map((b) => alphabet[b % alphabet.length]).join("")}`;
  const root = repo({ "README.md": "# demo\n" });
  stage(root, { "config.ts": `export const token = "${token}";\n` });
  const leaks = await checkGitleaks(root, { kind: "staged" });
  assert.equal(leaks.length, 1, JSON.stringify(leaks));
  assert.match(leaks[0].message, /github-pat/);
  git(root, "rm", "-q", "--cached", "config.ts");
  stage(root, { "config.ts": "export const token = process.env.TOKEN;\n" });
  assert.deepEqual(await checkGitleaks(root, { kind: "staged" }), []);
}

for (const root of roots) rmSync(root, { recursive: true, force: true });
console.log("project-standard: all checks passed");
