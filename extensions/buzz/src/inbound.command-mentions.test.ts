// Buzz tests cover commands addressed to the bot with a leading mention.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuzzBus } from "./buzz-bus.js";
import { BuzzDirectoryState } from "./directory-state.js";
import { handleBuzzInbound } from "./inbound.js";
import { BUZZ_NORMAL_MESSAGE_KIND, type BuzzInboundMessage } from "./message-event.js";
import { setBuzzRuntime } from "./runtime.js";
import type { ResolvedBuzzAccount } from "./types.js";

const ROOM_ID = "b25b8e40-eb1a-43a4-b56b-30a4e16df586";
const BOT_PUBLIC_KEY = "a".repeat(64);
const SENDER_PUBLIC_KEY = "b".repeat(64);

function createAccount(
  configOverrides: Partial<ResolvedBuzzAccount["config"]> = {},
): ResolvedBuzzAccount {
  return {
    accountId: "default",
    name: "OpenClaw",
    enabled: true,
    configured: true,
    relayUrl: "ws://127.0.0.1:3000",
    privateKey: "1".repeat(64),
    authTag: "",
    publicKey: BOT_PUBLIC_KEY,
    config: {
      groupPolicy: "open",
      groups: { [ROOM_ID]: { requireMention: true } },
      ...configOverrides,
    },
  };
}

function createMessage(overrides: Partial<BuzzInboundMessage> = {}): BuzzInboundMessage {
  return {
    id: "event-1",
    kind: BUZZ_NORMAL_MESSAGE_KIND,
    senderPubkey: SENDER_PUBLIC_KEY,
    text: "hello",
    channelId: ROOM_ID,
    createdAt: 1_777_000_000,
    mentionedPubkeys: [],
    ...overrides,
  };
}

function createLifecycle() {
  const signal = new AbortController().signal;
  return { signal, assertCurrent: () => signal.throwIfAborted(), historyMap: new Map() };
}

function createBus(): BuzzBus {
  return {
    publicKey: BOT_PUBLIC_KEY,
    directory: new BuzzDirectoryState({
      publicKey: BOT_PUBLIC_KEY,
      fallbackProfileName: "OpenClaw",
      channelIds: [ROOM_ID],
    }),
    refreshDirectory: vi.fn(async () => {}),
    isBotOwnedThread: vi.fn(async () => false),
    noteThreadParticipation: vi.fn(),
    isThreadParticipant: vi.fn(async () => false),
    sendText: vi.fn(async () => "reply-event-1"),
    sendTyping: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function firstDispatch(
  runtime: ReturnType<typeof createPluginRuntimeMock>,
): Parameters<typeof runtime.channel.inbound.dispatch>[0] {
  const call = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0];
  if (!call) {
    throw new Error("expected Buzz inbound dispatch");
  }
  return call[0];
}

describe("handleBuzzInbound commands after mentions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createCommandRuntime() {
    const runtime = createPluginRuntimeMock();
    const isCommand = (text?: string) => text?.startsWith("/") === true;
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockImplementation(
      isCommand,
    );
    vi.mocked(runtime.channel.text.hasControlCommand).mockImplementation(isCommand);
    setBuzzRuntime(runtime);
    return runtime;
  }

  function createCommandAccount() {
    return createAccount({
      groupPolicy: "allowlist",
      groups: { [ROOM_ID]: { requireMention: true, groupAllowFrom: [SENDER_PUBLIC_KEY] } },
    });
  }

  it("runs a command addressed to the bot by name", async () => {
    const runtime = createCommandRuntime();

    await handleBuzzInbound({
      account: createCommandAccount(),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage({
        text: "@OpenClaw /compact keep decisions",
        mentionedPubkeys: [BOT_PUBLIC_KEY],
      }),
      ...createLifecycle(),
    });

    expect(firstDispatch(runtime).ctxPayload).toMatchObject({
      CommandAuthorized: true,
      CommandBody: "/compact keep decisions",
      RawBody: "@OpenClaw /compact keep decisions",
    });
  });

  it("keeps a mention followed by prose as a message", async () => {
    const runtime = createCommandRuntime();

    await handleBuzzInbound({
      account: createCommandAccount(),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage({
        text: "@OpenClaw see /tmp/notes",
        mentionedPubkeys: [BOT_PUBLIC_KEY],
      }),
      ...createLifecycle(),
    });

    expect(runtime.channel.text.hasControlCommand).not.toHaveBeenCalled();
    expect(firstDispatch(runtime).ctxPayload.CommandBody).toBe("@OpenClaw see /tmp/notes");
  });
});
