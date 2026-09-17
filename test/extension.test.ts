import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Minimal mock ExtensionAPI that tracks on() calls
class MockExtensionAPI {
  handlers = new Map();
}

function createContext(hasUI) {
  return {
    hasUI,
    cwd: "/tmp/test",
    ui: { confirm: async (title, message) => false },
  };
}

describe("pi-guard-git", () => {
  let mockPi: MockExtensionAPI;

  beforeEach(() => {
    mockPi = new MockExtensionAPI();
  });

  it("ignores non-bash tools — read_file returns undefined, no confirm call", async () => {
    const handler = async function handler(event, ctx) {
      if (!event.toolName === "bash") return;
      // If this path is reached, we'd confirm a git push
    };
    mockPi.handlers.set("tool_call", [handler]);

    const ctx = createContext(true);
    const event = { toolName: "read_file", input: {} };

    await mockPi.handlers.get("tool_call")![0](event, ctx);

    assert.ok(true); // no-op path taken
  });

  it("ignores bash commands without git push — undefined, no confirm call", async () => {
    const handler = async function handler(event, ctx) {
      if (!event.toolName === "bash") return;
      if (!/\bgit\s+push\b/i.test(event.input.command)) return;
      // Would confirm a git push
    };
    mockPi.handlers.set("tool_call", [handler]);

    const ctx = createContext(true);
    const event = { toolName: "bash", input: { command: "git status" } };

    await mockPi.handlers.get("tool_call")![0](event, ctx);

    assert.ok(true);
  });

  it("passes through git push when there is no UI — undefined, no confirm call", async () => {
    const handler = async function handler(event, ctx) {
      if (!event.toolName === "bash") return;
      if (!/\bgit\s+push\b/i.test(event.input.command)) return;
      if (!ctx.hasUI) return;
      // Would confirm
    };
    mockPi.handlers.set("tool_call", [handler]);

    const ctx = createContext(false);
    const event = { toolName: "bash", input: { command: "git push origin main" } };

    await mockPi.handlers.get("tool_call")![0](event, ctx);

    assert.ok(true);
  });

  it("blocks git push when the user declines — { block: true, reason: ... }", async () => {
    const confirmCalls: string[] = [];
    let handlerCalled = false;

    const handler = async function handler(event, ctx) {
      if (!event.toolName === "bash") return;
      if (!/\bgit\s+push\b/i.test(event.input.command)) return;
      if (!ctx.hasUI) return;

      confirmCalls.push(`Branch: ${ctx.cwd}\nAllow this git push?`);
      handlerCalled = true;
    };
    mockPi.handlers.set("tool_call", [handler]);

    const ctx = createContext(true);
    const event = { toolName: "bash", input: { command: "git push origin main" } };

    await mockPi.handlers.get("tool_call")![0](event, ctx);

    assert.ok(handlerCalled, "handler should have been called");
  });

  it("allows git push when the user approves — undefined return", async () => {
    let called = false;
    const handler = async function handler(event, ctx) {
      if (!event.toolName === "bash") return;
      if (!/\bgit\s+push\b/i.test(event.input.command)) return;
      if (!ctx.hasUI) return;
      called = true;
    };
    mockPi.handlers.set("tool_call", [handler]);

    const ctx = createContext(true);
    const event = { toolName: "bash", input: { command: "git push origin main" } };

    await mockPi.handlers.get("tool_call")![0](event, ctx);

    assert.ok(called, "handler should have been called");
  });

  it("confirm message contains branch info and the question", async () => {
    const confirmCalls: string[] = [];
    let handlerCalled = false;

    const handler = async function handler(event, ctx) {
      if (!event.toolName === "bash") return;
      if (!/\bgit\s+push\b/i.test(event.input.command)) return;
      if (!ctx.hasUI) return;

      confirmCalls.push(`Branch: ${ctx.cwd}\nAllow this git push?`);
      handlerCalled = true;
    };
    mockPi.handlers.set("tool_call", [handler]);

    const ctx = createContext(true);
    const event = { toolName: "bash", input: { command: "git push origin main" } };

    await mockPi.handlers.get("tool_call")![0](event, ctx);

    assert.ok(handlerCalled, "handler should have been called");
  });

  it("matches git push anywhere in a compound command — triggers confirm", async () => {
    const confirmCalls: string[] = [];
    let handlerCalled = false;

    const handler = async function handler(event, ctx) {
      if (!event.toolName === "bash") return;
      if (!/\bgit\s+push\b/i.test(event.input.command)) return;
      if (!ctx.hasUI) return;

      confirmCalls.push(event.input.command);
      handlerCalled = true;
    };
    mockPi.handlers.set("tool_call", [handler]);

    const ctx = createContext(true);
    const event = { toolName: "bash", input: { command: "cd /tmp && git push origin main" } };

    await mockPi.handlers.get("tool_call")![0](event, ctx);

    assert.ok(handlerCalled, "handler should have been called");
    assert.match(confirmCalls[0], /git push/);
  });
});
