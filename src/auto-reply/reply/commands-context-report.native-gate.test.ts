/** Tests that native /context sees a running turn but not its own command reply. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";

const { reportNativeCliContextMock } = vi.hoisted(() => ({
  reportNativeCliContextMock: vi.fn(async () => ({ ok: true as const, text: "## Context Usage" })),
}));

vi.mock("../../agents/cli-native-context.js", () => ({
  reportNativeCliContext: reportNativeCliContextMock,
}));

const { buildContextReply } = await import("./commands-context-report.js");
const { createTestReplyOperation } = await import("./reply-run-registry.test-helpers.js");
const { testing: replyRunTesting } = await import("./reply-run-registry.test-support.js");

const SESSION_KEY = "agent:main:buzz:group:buzz:room";
const SESSION_ID = "openclaw-session";

function makeParams() {
  return {
    command: { commandBodyNormalized: "/context", channel: "buzz", senderIsOwner: true },
    sessionKey: SESSION_KEY,
    workspaceDir: "/tmp/workspace",
    provider: "claude-cli",
    model: "claude-opus-5-5",
    cfg: {},
    sessionEntry: {
      sessionId: SESSION_ID,
      cliSessionBindings: { "claude-cli": { sessionId: "native-session" } },
    },
  } as unknown as Parameters<typeof buildContextReply>[0];
}

describe("buildContextReply native run gate", () => {
  beforeEach(() => {
    reportNativeCliContextMock.mockClear();
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () =>
        [
          {
            id: "claude-cli",
            modelProvider: "anthropic",
            config: { command: "claude" },
            bundleMcp: false,
          },
        ] as never,
    });
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    replyRunTesting.resetReplyRunRegistry();
  });

  it("reports while only the command's own reply is open", async () => {
    createTestReplyOperation({ sessionKey: SESSION_KEY, sessionId: SESSION_ID });

    const result = await buildContextReply(makeParams());

    expect(result.text).toBe("🧠 /context from claude-cli\n\n## Context Usage");
    expect(reportNativeCliContextMock).toHaveBeenCalledOnce();
  });

  it("declines while a turn is running in the session", async () => {
    createTestReplyOperation({ sessionKey: SESSION_KEY, sessionId: SESSION_ID }).setPhase(
      "running",
    );

    const result = await buildContextReply(makeParams());

    expect(result.text).toContain("while this session runs a turn");
    expect(reportNativeCliContextMock).not.toHaveBeenCalled();
  });
});
