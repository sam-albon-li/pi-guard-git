import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

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

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = event.input.command || "";
    if (!/\bgit\s+push\b/i.test(command)) return;

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
