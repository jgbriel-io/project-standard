import { statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { git, listFiles, reader } from "./git.mjs";
import { governingDecisions, which } from "./governs.mjs";

const MAX_DECISIONS = 5;
const MAX_TEXT = 1500;
const MAX_TITLE = 100;
const FOOTER = "Read docs/decisions/<file> for each before continuing; if this change contradicts one, amend or supersede it in this PR.";

function payloadPaths(payload) {
  const file = payload?.tool_input?.file_path;
  return typeof file === "string" && file ? [file] : [];
}

const isDirectory = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function locate(path, cwd) {
  const abs = resolve(cwd, path.replaceAll("\\", "/"));
  let dir = dirname(abs);
  while (!isDirectory(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const [root, prefix = ""] = git(dir, ["rev-parse", "--show-toplevel", "--show-prefix"]).split(/\r?\n/);
  return { root, path: `${prefix}${relative(dir, abs)}`.replaceAll("\\", "/") };
}

const clip = (title) => (title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title);

export function hookContext(payload) {
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const byRoot = new Map();
  const sentences = [];
  for (const raw of new Set(payloadPaths(payload))) {
    let target;
    try {
      target = locate(raw, cwd);
    } catch {
      continue;
    }
    if (!byRoot.has(target.root)) byRoot.set(target.root, governingDecisions(listFiles(target.root, { untracked: true }), reader(target.root, false)));
    const [{ decisions }] = which([target.path], byRoot.get(target.root));
    const list = decisions.slice(0, MAX_DECISIONS).map((d) => `${d.number} ${clip(d.title)}`.trim()).join("; ");
    const sentence = `Decisions governing ${target.path}: ${list}.`;
    if (decisions.length && [...sentences, sentence, FOOTER].join(" ").length < MAX_TEXT) sentences.push(sentence);
  }
  return sentences.length ? [...sentences, FOOTER].join(" ") : "";
}

export async function hook(stream) {
  try {
    let input = "";
    stream.setEncoding("utf8");
    for await (const chunk of stream) input += chunk;
    const context = hookContext(JSON.parse(input));
    return context ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context } }) : "";
  } catch {
    return "";
  }
}
