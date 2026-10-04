import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliBackendPlugin } from "../plugins/cli-backend.types.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";

const { runCliAgentMock } = vi.hoisted(() => ({
  runCliAgentMock: vi.fn(async (_params: Record<string, unknown>) => ({
    payloads: [{ text: "## Context Usage" }],
    meta: { durationMs: 1 },
  })),
}));

vi.mock("./cli-runner.js", () => ({ runCliAgent: runCliAgentMock }));

const { reportNativeCliContext } = await import("./cli-native-context.js");

function registerBackend(overrides: Partial<CliBackendPlugin> = {}) {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () =>
      [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          config: {
            command: "claude",
            args: ["-p"],
            resumeArgs: ["-p", "--resume", "{sessionId}"],
            input: "stdin",
            output: "jsonl",
            sessionMode: "existing",
          },
          bundleMcp: false,
          pluginId: "anthropic",
          nativeContextReport: {
            buildPrompt: () => "/context",
            input: "arg",
            parseOutput: () => ({ ok: true, text: "## Context Usage" }),
          },
          ...overrides,
        },
      ] as never,
    resolvePluginSetupCliBackend: () => undefined,
  });
}

function reportParams(overrides: Record<string, unknown> = {}) {
  return {
    runtime: "claude-cli",
    config: {},
    sessionId: "openclaw-session",
    sessionKey: "agent:main:buzz:group:buzz:room",
    agentId: "main",
    workspaceDir: "/tmp/workspace",
    provider: "claude-cli",
    model: "claude-opus-5-5",
    cliSessionId: "native-session",
    cliSessionBinding: { sessionId: "native-session", authProfileId: "anthropic:token" },
    ...overrides,
  } as Parameters<typeof reportNativeCliContext>[0];
}

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  runCliAgentMock.mockClear();
});

describe("native CLI context report", () => {
  it("resumes the bound backend session with the backend-owned command", async () => {
    registerBackend();

    await expect(reportNativeCliContext(reportParams())).resolves.toEqual({
      ok: true,
      text: "## Context Usage",
    });
    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "/context",
        provider: "claude-cli",
        cliSessionId: "native-session",
        authProfileId: "anthropic:token",
        runId: "openclaw-session:native-context",
        controlOperation: "context",
        disableCliLiveSession: true,
      }),
    );
    expect(runCliAgentMock.mock.calls[0]?.[0]).not.toHaveProperty("cleanupCliLiveSessionOnRunEnd");
  });

  it("leaves sessions without a native report or resumable session to OpenClaw", async () => {
    registerBackend({ nativeContextReport: undefined });
    await expect(reportNativeCliContext(reportParams())).resolves.toBeUndefined();

    registerBackend();
    await expect(
      reportNativeCliContext(
        reportParams({ cliSessionId: undefined, cliSessionBinding: undefined }),
      ),
    ).resolves.toBeUndefined();
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("reports a failed native run instead of throwing", async () => {
    registerBackend();
    runCliAgentMock.mockRejectedValueOnce(new Error("session is locked"));

    await expect(reportNativeCliContext(reportParams())).resolves.toEqual({
      ok: false,
      reason: 'CLI backend "claude-cli" failed to report its native context: session is locked',
    });
  });
});
