import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import guard, {
  loadGuardConfig,
  parsePushDestinations,
  branchMatches,
} from "../index.ts";

// Minimal mock ExtensionAPI that tracks on() calls.
class MockExtensionAPI {
  handlers: Record<string, Array<(e: any, c: any) => Promise<any>>> = {};
  on(name: string, fn: (e: any, c: any) => Promise<any>) {
    (this.handlers[name] ??= []).push(fn);
  }
}

let tmpHome: string;
let tmpCwd: string;
const savedHome = process.env.HOME;
const savedGuardFile = process.env.PI_GUARD_GIT_CONFIG;

function homeConfigPath(): string {
  const dir = path.join(tmpHome, ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "pi-guard-git.config.json");
}

function makeCtx(opts: { hasUI?: boolean; cwd?: string; confirmResult?: boolean } = {}) {
  return {
    hasUI: opts.hasUI ?? true,
    cwd: opts.cwd ?? tmpCwd,
    ui: {
      confirm: async (_title: string, _message: string) => opts.confirmResult ?? false,
    },
  };
}

async function fire(pi: MockExtensionAPI, event: any, ctx: any): Promise<any> {
  return pi.handlers["tool_call"][0](event, ctx);
}

function bashEvent(command: string): any {
  return { toolName: "bash", input: { command } };
}

describe("pi-guard-git", () => {
  let pi: MockExtensionAPI;
  let confirms: string[];

  beforeEach(() => {
    // Isolate config lookup: fresh HOME, no env override.
    tmpHome = mkdtempSync(path.join(tmpdir(), "gpg-test-home-"));
    tmpCwd = mkdtempSync(path.join(tmpdir(), "gpg-test-cwd-"));
    process.env.HOME = tmpHome;
    delete process.env.PI_GUARD_GIT_CONFIG;

    pi = new MockExtensionAPI();
    guard(pi as any);
    confirms = [];
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedGuardFile === undefined) delete process.env.PI_GUARD_GIT_CONFIG;
    else process.env.PI_GUARD_GIT_CONFIG = savedGuardFile;
  });

  // --- original behavior (unchanged) ---

  it("ignores non-bash tools — read_file returns undefined, no confirm call", async () => {
    const r = await fire(pi, { toolName: "read_file", input: {} }, makeCtx());
    assert.equal(r, undefined);
  });

  it("ignores bash commands without git push — undefined, no confirm call", async () => {
    for (const command of ["git status", "echo hi"]) {
      const r = await fire(pi, bashEvent(command), makeCtx());
      assert.equal(r, undefined);
    }
  });

  it("passes through git push when there is no UI — undefined, no confirm call", async () => {
    const ctx = makeCtx({ hasUI: false });
    const r = await fire(pi, bashEvent("git push origin main"), ctx);
    assert.equal(r, undefined);
  });

  it("blocks git push when the user declines — { block: true, reason: ... }", async () => {
    const r = await fire(pi, bashEvent("git push origin main"), makeCtx({ confirmResult: false }));
    assert.deepEqual(r, { block: true, reason: "Git push blocked by user after review" });
  });

  it("allows git push when the user approves — undefined return", async () => {
    const r = await fire(pi, bashEvent("git push origin main"), makeCtx({ confirmResult: true }));
    assert.equal(r, undefined);
  });

  it("confirm message contains branch info and the question", async () => {
    const ctx = {
      hasUI: true,
      cwd: tmpCwd,
      ui: {
        confirm: async (_t: string, m: string) => {
          confirms.push(m);
          return false;
        },
      },
    };
    await fire(pi, bashEvent("git push origin main"), ctx);
    assert.equal(confirms.length, 1);
    assert.match(confirms[0], /Branch:/);
    assert.ok(confirms[0].includes("Allow this git push?"));
  });

  it("matches git push anywhere in a compound command — triggers confirm", async () => {
    const ctx = {
      hasUI: true,
      cwd: tmpCwd,
      ui: {
        confirm: async (_t: string, m: string) => {
          confirms.push(m);
          return false;
        },
      },
    };
    await fire(pi, bashEvent("cd /tmp && git push origin main"), ctx);
    assert.equal(confirms.length, 1);
  });

  // --- branch rules: allow list ---

  it("allow-listed branch skips the confirm dialog (TUI)", async () => {
    writeFileSync(homeConfigPath(), JSON.stringify({ allowBranches: ["feat/*"] }));
    const ctx = {
      hasUI: true,
      cwd: tmpCwd,
      ui: {
        confirm: async (_t: string, m: string) => {
          confirms.push(m);
          return false;
        },
      },
    };
    const r = await fire(pi, bashEvent("git push -u origin feat/x"), ctx);
    assert.equal(r, undefined);
    assert.equal(confirms.length, 0);
  });

  it("allow list does not skip a refspec pushing to an unlisted branch", async () => {
    writeFileSync(homeConfigPath(), JSON.stringify({ allowBranches: ["feat/*"] }));
    const ctx = {
      hasUI: true,
      cwd: tmpCwd,
      ui: {
        confirm: async (_t: string, m: string) => {
          confirms.push(m);
          return false;
        },
      },
    };
    await fire(pi, bashEvent("git push origin feat/x:main"), ctx);
    assert.equal(confirms.length, 1);
  });

  // --- branch rules: deny list ---

  it("deny-listed branch still confirms (TUI)", async () => {
    writeFileSync(homeConfigPath(), JSON.stringify({ denyBranches: ["main"] }));
    const ctx = {
      hasUI: true,
      cwd: tmpCwd,
      ui: {
        confirm: async (_t: string, m: string) => {
          confirms.push(m);
          return false;
        },
      },
    };
    await fire(pi, bashEvent("git push origin main"), ctx);
    assert.equal(confirms.length, 1);
  });

  it("deny wins when a destination is both allowed and denied", async () => {
    writeFileSync(
      homeConfigPath(),
      JSON.stringify({ allowBranches: ["*"], denyBranches: ["main"] }),
    );
    const ctx = {
      hasUI: true,
      cwd: tmpCwd,
      ui: {
        confirm: async (_t: string, m: string) => {
          confirms.push(m);
          return false;
        },
      },
    };
    await fire(pi, bashEvent("git push origin main"), ctx);
    assert.equal(confirms.length, 1);
  });

  // --- branch rules: default (unlisted) and headless ---

  it("unlisted branch confirms with no config present", async () => {
    const ctx = {
      hasUI: true,
      cwd: tmpCwd,
      ui: {
        confirm: async (_t: string, m: string) => {
          confirms.push(m);
          return false;
        },
      },
    };
    await fire(pi, bashEvent("git push origin develop"), ctx);
    assert.equal(confirms.length, 1);
  });

  it("headless is a no-op for deny-listed branches", async () => {
    writeFileSync(homeConfigPath(), JSON.stringify({ denyBranches: ["main"] }));
    const r = await fire(pi, bashEvent("git push origin main"), makeCtx({ hasUI: false }));
    assert.equal(r, undefined);
  });

  it("headless is a no-op for allow-listed branches", async () => {
    writeFileSync(homeConfigPath(), JSON.stringify({ allowBranches: ["feat/*"] }));
    const r = await fire(pi, bashEvent("git push -u origin feat/x"), makeCtx({ hasUI: false }));
    assert.equal(r, undefined);
  });

  it("invalid config JSON falls back to prompt-everything", async () => {
    writeFileSync(homeConfigPath(), "{ not json");
    const ctx = {
      hasUI: true,
      cwd: tmpCwd,
      ui: {
        confirm: async (_t: string, m: string) => {
          confirms.push(m);
          return false;
        },
      },
    };
    await fire(pi, bashEvent("git push origin feat/x"), ctx);
    assert.equal(confirms.length, 1);
  });

  // --- destination ref parsing ---

  it("refspec HEAD:main is matched against the deny list", async () => {
    writeFileSync(homeConfigPath(), JSON.stringify({ denyBranches: ["main"] }));
    const ctx = {
      hasUI: true,
      cwd: tmpCwd,
      ui: {
        confirm: async (_t: string, m: string) => {
          confirms.push(m);
          return false;
        },
      },
    };
    await fire(pi, bashEvent("git push origin HEAD:main"), ctx);
    assert.equal(confirms.length, 1);
  });

  it("refspec to an allow-listed branch skips the dialog", async () => {
    writeFileSync(homeConfigPath(), JSON.stringify({ allowBranches: ["release/*"] }));
    const r = await fire(pi, bashEvent("git push origin +HEAD:refs/heads/release/1.0"), makeCtx());
    assert.equal(r, undefined);
  });

  it("parsePushDestinations handles the common push shapes", () => {
    assert.deepEqual(parsePushDestinations("git push origin main"), ["main"]);
    assert.deepEqual(parsePushDestinations("git push -u origin feat/x"), ["feat/x"]);
    assert.deepEqual(parsePushDestinations("git push origin HEAD:main"), ["main"]);
    assert.deepEqual(parsePushDestinations("git push origin +HEAD:refs/heads/main"), ["main"]);
    assert.deepEqual(parsePushDestinations("git push origin :main"), ["main"]); // delete
    assert.deepEqual(parsePushDestinations("git push origin main dev"), ["main", "dev"]);
    assert.deepEqual(parsePushDestinations("git push"), []);
    assert.deepEqual(parsePushDestinations("git push origin"), []);
    assert.deepEqual(parsePushDestinations("cd /tmp && git push origin main"), ["main"]);
  });

  // --- glob matching ---

  it("glob feat/* matches feat/x but not feature/x", () => {
    assert.ok(branchMatches("feat/x", "feat/*"));
    assert.ok(!branchMatches("feature/x", "feat/*"));
    assert.ok(branchMatches("main", "main"));
    assert.ok(!branchMatches("Main", "main")); // case-sensitive
  });

  it("glob boundary is enforced by the handler too", async () => {
    writeFileSync(homeConfigPath(), JSON.stringify({ allowBranches: ["feat/*"] }));
    const ctx = {
      hasUI: true,
      cwd: tmpCwd,
      ui: {
        confirm: async (_t: string, m: string) => {
          confirms.push(m);
          return false;
        },
      },
    };
    await fire(pi, bashEvent("git push -u origin feature/x"), ctx);
    assert.equal(confirms.length, 1); // feature/x is NOT feat/*
  });

  // --- config search order ---

  it("PI_GUARD_GIT_CONFIG env var wins over home config", async () => {
    writeFileSync(homeConfigPath(), JSON.stringify({ denyBranches: ["main"] }));
    const envFile = path.join(tmpHome, "env-config.json");
    writeFileSync(envFile, JSON.stringify({ allowBranches: ["main"] }));
    process.env.PI_GUARD_GIT_CONFIG = envFile;

    const r = await fire(pi, bashEvent("git push origin main"), makeCtx());
    assert.equal(r, undefined); // allowed via env config despite home deny
  });

  it("cwd .pi config wins over home config", async () => {
    writeFileSync(homeConfigPath(), JSON.stringify({ denyBranches: ["main"] }));
    mkdirSync(path.join(tmpCwd, ".pi"));
    writeFileSync(
      path.join(tmpCwd, ".pi", "pi-guard-git.config.json"),
      JSON.stringify({ allowBranches: ["main"] }),
    );

    const r = await fire(pi, bashEvent("git push origin main"), makeCtx());
    assert.equal(r, undefined); // allowed via cwd config despite home deny
  });

  it("loadGuardConfig returns empty lists when no config exists", () => {
    assert.deepEqual(loadGuardConfig(tmpCwd), { allowBranches: [], denyBranches: [] });
  });
});
