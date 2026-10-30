import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function runGit(cwd: string, cmd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

function getPushDiff(cwd: string): { summary: string; diff: string } {
  const branch = runGit(cwd, "git rev-parse --abbrev-ref HEAD").trim() || "HEAD";
  let upstream = "";
  try {
    upstream = runGit(cwd, "git rev-parse --abbrev-ref --symbolic-full-name @{u}").trim();
  } catch {}

  let diff = "";
  let log = "";

  try {
    if (upstream) {
      diff = runGit(cwd, `git diff --color=never ${upstream}...HEAD`);
      log = runGit(cwd, `git log --oneline ${upstream}..HEAD`);
    } else {
      diff = runGit(cwd, "git diff --color=never HEAD");
      log = runGit(cwd, "git log --oneline -5 HEAD");
    }
  } catch {}

  const status = runGit(cwd, "git status --porcelain");
  const summary = [
    `Branch: ${branch}`,
    upstream ? `Upstream: ${upstream}` : "Upstream: (none)",
    `Pending commits:`,
    log || "(none)",
    `Working tree:`,
    status || "(clean)",
  ].join("\n");

  return { summary, diff };
}

// ---------------------------------------------------------------------------
// Branch rules config
//
// Search order:
//   1. $PI_GUARD_GIT_CONFIG
//   2. <session cwd>/.pi/pi-guard-git.config.json
//   3. ~/.pi/agent/pi-guard-git.config.json
//
// Format: { "allowBranches": ["feat/*"], "denyBranches": ["main"] }
// Both keys are optional arrays of branch names (exact, or `*` glob).
// A missing or invalid file resolves to empty lists — the original
// prompt-every-push behavior.
// ---------------------------------------------------------------------------

interface IGuardConfig {
  allowBranches?: unknown;
  denyBranches?: unknown;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

export function loadGuardConfig(cwd: string): { allowBranches: string[]; denyBranches: string[] } {
  let file: string | null = null;
  if (process.env.PI_GUARD_GIT_CONFIG) {
    file = process.env.PI_GUARD_GIT_CONFIG;
  } else {
    const cwdFile = path.join(cwd, ".pi", "pi-guard-git.config.json");
    file = existsSync(cwdFile) ? cwdFile : path.join(homedir(), ".pi", "agent", "pi-guard-git.config.json");
  }

  if (!file || !existsSync(file)) return { allowBranches: [], denyBranches: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { allowBranches: [], denyBranches: [] };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { allowBranches: [], denyBranches: [] };
  }

  const cfg = parsed as IGuardConfig;
  return { allowBranches: stringList(cfg.allowBranches), denyBranches: stringList(cfg.denyBranches) };
}

// ---------------------------------------------------------------------------
// Destination ref parsing and branch matching
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Full-string, case-sensitive match; `*` is the only wildcard. */
export function branchMatches(name: string, pattern: string): boolean {
  if (!pattern.includes("*")) return name === pattern;
  const re = new RegExp("^" + pattern.split("*").map(escapeRegExp).join(".*") + "$");
  return re.test(name);
}

export function matchesAnyBranch(name: string, patterns: string[]): boolean {
  return patterns.some((p) => branchMatches(name, p));
}

/**
 * Extract destination branch names from a git push command.
 * Refspecs contribute what is after the last `:` (leading `+` and
 * `refs/heads/` stripped); plain branch arguments after the remote are used
 * as-is. Returns [] when the command names no explicit destinations (bare
 * `git push`, `git push <remote>`) — the caller falls back to the upstream
 * or current branch.
 */
export function parsePushDestinations(command: string): string[] {
  const m = /\bgit\s+push\b/i.exec(command);
  if (!m) return [];

  // Only consider up to the next shell separator (&&, ||, ;, |).
  const rest = command.slice(m.index + m[0].length);
  const stop = rest.search(/\|\||&&|;|\|/);
  const segment = (stop === -1 ? rest : rest.slice(0, stop)).trim();
  if (!segment) return [];

  const raw = segment.split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (t === "-o" || t === "--push-option") {
      i += 1; // skip the flag's value
      continue;
    }
    if (t.startsWith("-")) continue;
    tokens.push(t);
  }

  const plain: string[] = [];
  const dests: string[] = [];
  for (const t of tokens) {
    if (t.includes(":")) {
      let d = t.slice(t.lastIndexOf(":") + 1);
      d = d.replace(/^\+/, "").replace(/^refs\/heads\//, "");
      if (d) dests.push(d);
    } else {
      plain.push(t);
    }
  }

  // The first plain token is the remote; remaining plain tokens are branch
  // names pushed to same-named refs.
  for (let i = 1; i < plain.length; i++) dests.push(plain[i]);
  return dests;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = event.input.command || "";
    if (!/\bgit\s+push\b/i.test(command)) return;

    // Branch rules: destinations on the allow list skip the dialog. Deny-
    // listed and unlisted destinations fall through to the normal flow.
    const cfg = loadGuardConfig(ctx.cwd);
    let dests = parsePushDestinations(command);
    if (dests.length === 0) {
      // Bare `git push` / `git push <remote>`: the destination is the
      // upstream branch, or the current branch when there is no upstream.
      const upstream = runGit(ctx.cwd, "git rev-parse --abbrev-ref --symbolic-full-name @{u}").trim();
      const branch = runGit(ctx.cwd, "git rev-parse --abbrev-ref HEAD").trim() || "HEAD";
      dests = [upstream.includes("/") ? upstream.slice(upstream.indexOf("/") + 1) : branch];
    }

    const denied = dests.some((d) => matchesAnyBranch(d, cfg.denyBranches));
    if (!denied && dests.every((d) => matchesAnyBranch(d, cfg.allowBranches))) return;

    // Only prompt in TUI/RPC modes with UI
    if (!ctx.hasUI) return;

    const { summary, diff } = getPushDiff(ctx.cwd);

    const diffPreview = diff
      ? diff.slice(0, 4000) + (diff.length > 4000 ? "\n...[truncated]..." : "")
      : "(no diff detected)";

    const message = `${summary}

Diff preview:
\`\`\`diff
${diffPreview}
\`\`\`

Allow this git push?`;

    const ok = await ctx.ui.confirm("Git Push Permission", message);

    if (!ok) {
      return { block: true, reason: "Git push blocked by user after review" };
    }

    // User approved, allow the push to proceed
    return;
  });
}
