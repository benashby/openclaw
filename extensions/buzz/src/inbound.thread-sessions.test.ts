// Buzz tests cover per-thread sessions and sticky thread participation.
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
const OTHER_PUBLIC_KEY = "c".repeat(64);

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

describe("handleBuzzInbound threadSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createThreadBus(botRoles = new Map<string, string>()) {
    const bus = createBus();
    bus.directory.replaceMemberships(
      new Map([
        [
          ROOM_ID,
          {
            roomId: ROOM_ID,
            createdAt: 1_777_000_000,
            eventId: "membership-threads",
            publisherPublicKey: OTHER_PUBLIC_KEY,
            members: new Set([BOT_PUBLIC_KEY, SENDER_PUBLIC_KEY, OTHER_PUBLIC_KEY]),
            roles: botRoles,
          },
        ],
      ]),
    );
    return bus;
  }

  it("keeps one room session when thread sessions are off", async () => {
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);

    await handleBuzzInbound({
      account: createAccount(),
      cfg: {} satisfies OpenClawConfig,
      bus: createThreadBus(),
      message: createMessage({ threadId: "event-root", mentionedPubkeys: [BOT_PUBLIC_KEY] }),
      ...createLifecycle(),
    });

    expect(firstDispatch(runtime).route.sessionKey).not.toContain(":thread:");
  });

  it.each([
    { account: true, room: false, threaded: false },
    { account: false, room: true, threaded: true },
  ])(
    "lets a room set threadSessions $room over the account's $account",
    async ({ account, room, threaded }) => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);

      await handleBuzzInbound({
        account: createAccount({
          threadSessions: account,
          groups: { [ROOM_ID]: { requireMention: true, threadSessions: room } },
        }),
        cfg: {} satisfies OpenClawConfig,
        bus: createThreadBus(),
        message: createMessage({ id: "event-task", mentionedPubkeys: [BOT_PUBLIC_KEY] }),
        ...createLifecycle(),
      });

      expect(firstDispatch(runtime).route.sessionKey.endsWith(":thread:event-task")).toBe(threaded);
    },
  );

  it("starts a fresh thread session rooted at a top-level mention", async () => {
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);
    const bus = createThreadBus();

    await handleBuzzInbound({
      account: createAccount({ threadSessions: true }),
      cfg: {} satisfies OpenClawConfig,
      bus,
      message: createMessage({ id: "event-task", mentionedPubkeys: [BOT_PUBLIC_KEY] }),
      ...createLifecycle(),
    });

    const dispatch = firstDispatch(runtime);
    expect(dispatch.route.sessionKey).toMatch(/:thread:event-task$/u);
    expect(dispatch.ctxPayload).toMatchObject({ MessageThreadId: "event-task" });
    expect(bus.noteThreadParticipation).toHaveBeenCalledWith("event-task");
    await dispatch.delivery.deliver({ text: "on it" }, { kind: "final" });
    expect(bus.sendText).toHaveBeenCalledWith({
      channelId: ROOM_ID,
      text: "on it",
      threadId: "event-task",
      replyToId: "event-task",
    });
  });

  it("routes thread replies to the thread root's session", async () => {
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);

    await handleBuzzInbound({
      account: createAccount({ threadSessions: true }),
      cfg: {} satisfies OpenClawConfig,
      bus: createThreadBus(),
      message: createMessage({
        id: "event-reply",
        threadId: "event-task",
        mentionedPubkeys: [BOT_PUBLIC_KEY],
      }),
      ...createLifecycle(),
    });

    expect(firstDispatch(runtime).route.sessionKey).toMatch(/:thread:event-task$/u);
  });

  it("lets a thread participant hear unmentioned replies", async () => {
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);
    const bus = createThreadBus();
    vi.mocked(bus.isThreadParticipant).mockResolvedValue(true);

    await handleBuzzInbound({
      account: createAccount({ threadSessions: true }),
      cfg: {} satisfies OpenClawConfig,
      bus,
      message: createMessage({ id: "event-follow-up", threadId: "event-task" }),
      ...createLifecycle(),
    });

    expect(bus.isThreadParticipant).toHaveBeenCalledWith({
      channelId: ROOM_ID,
      threadRootId: "event-task",
    });
    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
    expect(firstDispatch(runtime).ctxPayload).toMatchObject({ WasMentioned: true });
    expect(firstDispatch(runtime).route.sessionKey).toMatch(/:thread:event-task$/u);
  });

  it("keeps unmentioned thread replies away from non-participants", async () => {
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);

    await handleBuzzInbound({
      account: createAccount({ threadSessions: true }),
      cfg: {} satisfies OpenClawConfig,
      bus: createThreadBus(),
      message: createMessage({ threadId: "event-task" }),
      ...createLifecycle(),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("stays quiet when a thread reply mentions only another bot", async () => {
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);
    const bus = createThreadBus(new Map([[OTHER_PUBLIC_KEY, "bot"]]));
    vi.mocked(bus.isThreadParticipant).mockResolvedValue(true);

    await handleBuzzInbound({
      account: createAccount({ threadSessions: true }),
      cfg: {} satisfies OpenClawConfig,
      bus,
      message: createMessage({ threadId: "event-task", mentionedPubkeys: [OTHER_PUBLIC_KEY] }),
      ...createLifecycle(),
    });

    expect(bus.isThreadParticipant).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("does not let a bare command bypass mentions for every bot", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
    vi.mocked(runtime.channel.text.hasControlCommand).mockReturnValue(true);
    setBuzzRuntime(runtime);

    await handleBuzzInbound({
      account: createAccount({
        threadSessions: true,
        groupPolicy: "allowlist",
        groups: { [ROOM_ID]: { requireMention: true, groupAllowFrom: [SENDER_PUBLIC_KEY] } },
      }),
      cfg: {} satisfies OpenClawConfig,
      bus: createThreadBus(),
      message: createMessage({ text: "/new", threadId: "event-task" }),
      ...createLifecycle(),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });
});
