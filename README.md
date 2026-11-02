# project-standard

A shared check and an agent-config generator for repos that follow the project standard, plus the templates those repos start from. It uses only Node's standard library, and runs on Node 20+ and on Bun.

## Install

Pin a tag as a dev dependency:

```json
"devDependencies": {
  "project-standard": "github:jgbriel-io/project-standard#v0.2.0"
}
```

Tags are `vX.Y.Z`. Up to `standard-v0.1.0` the package lived in `jgbriel-io/jgbriel-skills` under `project-standard/`; from `v0.2.0` it is this repository, with the files at the root. The `package.json` never gets a `prepare`, `prepack`, `install` or `build` script. With one of those scripts, npm would run an install inside the git clone.

## Commands

| Command | Does |
|---|---|
| `project-standard sync` | Regenerates the Cursor, Codex and Kiro copies from the Claude sources, and `.codex/hooks.json` once a decision carries `governs`. Deletes generated files that no longer have a source. Prints every write and delete |
| `project-standard check --staged` | Pre-commit. Reads the staged content from the index, not the working tree |
| `project-standard check --base <ref>` | CI. Checks what changed between `<ref>` and `HEAD`. An all-zeros or unknown ref falls back to `HEAD^`. After the findings, lists the decisions that govern the change (see Governs) |
| `project-standard check --all` | Migration. Checks every tracked file and scans the full history for secrets |
| `project-standard check --governs` | Pre-push warning. Prints each `governs` glob that matches no tracked file as `path:line: [governs] glob "…" matches no tracked file`, with the line of the decision's `governs:` key. Always exits 0 |
| `project-standard which <path...>` | Prints, for each path, the accepted decisions whose `governs` globs match it, as `path: NNNN Title`, or `path: none`. Always exits 0 |
| `project-standard hook` | Claude Code and Codex `PreToolUse` hook. Reads the payload on stdin and prints the decisions that govern the file or files about to be written as agent context. Never blocks, always exits 0, prints nothing on a miss or an error |

The four modes of `check` are mutually exclusive. Findings print as `path:line: [check] message`, and any finding exits 1. The one non-failing mode is `check --governs`: its warnings never change the exit code.

### Governs

A decision may name the code it governs in an optional `governs:` block list of repo-relative globs. A repository whose decisions carry none sees no change.

```yaml
governs:
  - "src/api/**"
  - "src/{api,web}/*.ts"
```

`*` matches within one path segment and `**` across segments; a trailing `**` needs at least one segment below it, so `src/api/**` does not match `src/api` itself. Braces expand, dot segments match like any other, and matching is case-sensitive. `?` and `[...]` are not supported. `check` fails a decision whose `governs` is a flow list (`[a, b]`) or a scalar, has no items, an empty or non-string item, an item with leading or trailing whitespace, an item with `?`, `[` or `]`, or a bare `*` or `**`; it does not check that a glob matches any file. `check --governs` does, as a warning: it prints every `governs` glob of an accepted decision that matches no tracked file, on the line of that decision's `governs:` key, and always exits 0, so it can run from pre-push without blocking a push.

Under `check --base`, after the findings, the change is matched against the accepted decisions. When a `governs` glob matches a changed, renamed or deleted file, it prints `Decisions governing this change:` and up to 5 of those decisions, in ascending number, as `NNNN Title (path)`. That is output for the CI log, not a finding: the exit code does not change. `check --staged` lists nothing, so a commit stays quiet. Neither feature prints anything when no decision carries `governs`.

### Hook

`project-standard hook` tells Claude Code or Codex which decisions govern the files it is about to write. It reads the payload on stdin:

| Agent | Detected by | Paths read |
|---|---|---|
| Claude Code | default | `tool_input.file_path`, absolute |
| Codex | `tool_name` is `apply_patch` | the `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:` headers in `tool_input.command`, absolute or relative to the payload's `cwd`; a patch may name several |

For Claude Code, wire it in `.claude/settings.json` by hand:

```json
{ "hooks": { "PreToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "bunx --bun project-standard hook", "timeout": 10 }] }] } }
```

It prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"…"}}`, never a `permissionDecision`, so the edit always goes ahead and the agent reads the context next to the tool result. The repository is the one that holds the edited path (`git rev-parse --show-toplevel` from its nearest existing directory), not `CLAUDE_PROJECT_DIR`, so a path inside a worktree reads that worktree's decisions. At most 5 decisions per path, in ascending number, and under 1,500 characters in total across all the paths of a patch; a path whose sentence no longer fits is left out.

For Codex, `sync` generates `.codex/hooks.json` and `drift` checks it, so nothing is wired by hand. The file exists only while at least one `docs/decisions/NNNN-*.md` carries `governs`; `sync` deletes it once none does. Its command is `<runner> project-standard hook`, for both `command` and `commandWindows`, with the runner taken from the lockfile at the repo root: `bunx --bun` for `bun.lock` or `bun.lockb`, `pnpm exec` for `pnpm-lock.yaml`, `npx --no` otherwise. Each developer must trust the project's `.codex/` layer and this hook once per machine, with `/hooks` in Codex. Changing the generated entry, which a different runner does, asks for that trust again.

On Windows, Codex runs the command through `cmd.exe` from its own working directory, which may be a subdirectory. `npx --no`, `bunx --bun` and `pnpm exec` all resolve the local `project-standard` from there, so Codex need not start at the repo root; a relative `node node_modules/project-standard/cli.mjs hook` does not.

## Checks

| Check | Runs on a partial scope when | Fails when |
|---|---|---|
| `frontmatter` | a `docs/**/*.md` outside `docs/archive/` changed | `type` or `status` is missing or not an allowed value. A decision also fails on a `number` that does not match its file name, a date not in `YYYY-MM-DD`, a mismatch between `superseded_by` and `superseded`, or a `governs` that is not a block list of non-empty globs (see Governs) |
| `links` | a `.md` in `docs/`, the root `README.md` or `AGENTS.md` changed | a relative link does not resolve to a **tracked** file with the exact case, leaves the repo, or is a `[[wikilink]]`. When a change deletes or renames a file, only links pointing at the removed path are reported |
| `decisions` | anything under `docs/decisions/` changed | numbers do not run contiguously from `0001`, or a file name is not `NNNN-slug.md`. It also fails unless `docs/decisions/README.md` has exactly one row per file, with the file's number, link and status |
| `agents` | always | `AGENTS.md`, plus its `@imports` that resolve to tracked files (up to 5 hops), plus `.claude/rules/` files without `paths:`, reaches 200 lines |
| `drift` | always | a generated copy differs from what `sync` would write (CRLF ignored), is missing, or has no source |
| `gitleaks` | always | Gitleaks 8.30.1 finds a secret in the staged content, the commit range or the full history |

Gitleaks is downloaded once per machine from its GitHub release and checked against the SHA-256 pinned in `lib/gitleaks.mjs`. It is cached in `%LOCALAPPDATA%\project-standard` or `~/.cache/project-standard`. If the binary cannot be obtained, that is a finding: an unavailable scanner is not a pass. False positives go in `.gitleaksignore` by fingerprint.

## Generated agent config

Edit the Claude sources only. The copies are committed, and `drift` fails when one differs.

| Source | Cursor | Codex | Kiro |
|---|---|---|---|
| `.mcp.json` | `.cursor/mcp.json` (`type: "stdio"` added, `${VAR}` rewritten to `${env:VAR}`) | `.codex/config.toml` (`${VAR}` env forwarded by name as `env_vars`, literal env as `env`, `Authorization: Bearer ${X}` as `bearer_token_env_var`, other `${X}` headers as `env_http_headers`) | `.kiro/settings/mcp.json` |
| `.claude/skills/<name>/` | `.agents/skills/<name>/` | `.agents/skills/<name>/` | `.kiro/skills/<name>/` |
| `.claude/rules/**/*.md` | `.cursor/rules/<flat>.mdc`: `paths` becomes `globs`, with braces expanded; `alwaysApply: true` when there is no `paths` | none | `.kiro/steering/<flat>.md`: `inclusion: fileMatch` with a `fileMatchPattern` list; `inclusion: always` when there is no `paths` |
| committed `docs/decisions/*.md` with a non-empty `governs` | none | `.codex/hooks.json` (see [Hook](#hook)) | none |

`sync` refuses to write anything, and names the server, when a target cannot express the source:

- `${VAR:-default}`;
- SSE transport;
- a key other than `type`, `command`, `args`, `env`, `url` or `headers`;
- `${VAR}` in `command`, `args` or `url`, since Codex and Kiro expand variables only in env and headers;
- a Codex env var that is renamed rather than forwarded under its own name.

All generated paths belong to `sync`. Add them to the formatter's ignore list (`templates/.prettierignore`), or the formatter reflows them and `drift` fails on every commit.

Known limits:

- **Codex** loads a project's `.codex/config.toml` only after that project is trusted in the user's Codex config. `.codex/hooks.json` is trusted through `/hooks`, once per machine and again whenever its entry changes (see Hook).
- **Cursor** also reads `.claude/skills/` itself, so it sees each skill twice.
- **Serena** runs with the same `--context` in every agent.

## Templates

Files in `templates/` are copied into a repo and their `{placeholders}` filled in.

| Placeholder | Value |
|---|---|
| `{pm}` | `npm`, `bun` or `pnpm` |
| `{exec}` | `npx --no`, `bunx --bun` or `pnpm exec` |

Two files are renamed on copy: `AGENTS.template.md` becomes `AGENTS.md`, and `CLAUDE.template.md` becomes `CLAUDE.md`. The `.template` suffix keeps them from loading as instructions while you work in this repo.

- `hooks/pre-commit` is the husky hook body.
- `ci/checks-step.yml` is the step for the CI `checks` job. That job needs `fetch-depth: 0`.
- `docs/README.md` lists a row per folder. Delete the rows for folders the repo does not have.

Configs for lint, formatting, TypeScript, tests, Sonar, the full CI workflow, Dependabot and the runbook are added after the first repo proves them.

## Format sources

- Cursor: [MCP](https://cursor.com/docs/context/mcp), [rules](https://cursor.com/docs/context/rules), [skills](https://cursor.com/docs/context/skills)
- Codex: [MCP](https://developers.openai.com/codex/mcp), [skills](https://developers.openai.com/codex/skills)
- Kiro: [MCP configuration](https://kiro.dev/docs/mcp/configuration/), [steering](https://kiro.dev/docs/steering/), [skills](https://kiro.dev/docs/skills/)
- [Gitleaks](https://github.com/gitleaks/gitleaks)
- MCP servers: [SonarQube](https://github.com/SonarSource/sonarqube-mcp-server), [Serena](https://oraios.github.io/serena/02-usage/030_clients.html), [Playwright](https://github.com/microsoft/playwright-mcp), [SocratiCode](https://github.com/giancarloerra/socraticode)

## Test

```
node test.mjs
```

Each check gets throwaway git repos: one that should fail and a fixed twin that should pass. The first run downloads Gitleaks.
