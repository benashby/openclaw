import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBuzzRelayFixture } from "./buzz-relay.test-harness.js";
import { startBuzzGatewayAccount } from "./gateway.js";
import { setBuzzRuntime } from "./runtime.js";
import { resolveBuzzAccount } from "./types.js";

let stateDir: string;
let fixture: Awaited<ReturnType<typeof createBuzzRelayFixture>>;

beforeEach(async () => {
  // openclaw-temp-dir: allow extension tests cannot import root test helpers.
  stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-buzz-auto-join-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  fixture = await createBuzzRelayFixture();
});

afterEach(async () => {
  try {
    await fixture.close();
  } finally {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function rosterEvent(role: "bot" | "member", createdAt: number) {
  return fixture.signRelay({
    kind: 39002,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", fixture.roomId],
      ["p", fixture.botPublicKey, "", role],
      ["p", fixture.senderPublicKey, "", "member"],
    ],
  });
}

function setRosterRole(role: "bot" | "member", createdAt: number) {
  const index = fixture.events.findIndex((event) => event.kind === 39002);
  fixture.events.splice(index, 1, rosterEvent(role, createdAt));
}

async function runGateway(groups: NonNullable<OpenClawConfig["channels"]>["buzz"]["groups"]) {
  const runtime = createPluginRuntimeMock();
  runtime.state.openKeyedStore = (options) => createPluginStateKeyedStoreForTests("buzz", options);
  setBuzzRuntime(runtime);
  const handled: string[] = [];
  vi.mocked(runtime.channel.inbound.dispatch).mockImplementation(async (params) => {
    handled.push(String(params.ctxPayload.RawBody));
    return {
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: params.ctxPayload,
      routeSessionKey: params.route.sessionKey,
      dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } },
    };
  });
  const cfg = {
    channels: {
      buzz: {
        relayUrl: fixture.relayUrl,
        privateKey: fixture.botPrivateKey,
        groupPolicy: "open",
        groups,
      },
    },
  } satisfies OpenClawConfig;
  const abort = new AbortController();
  let readyCount = 0;
  const ready = [createDeferred<void>(), createDeferred<void>()];
  const ctx = createStartAccountContext({
    account: resolveBuzzAccount({ cfg }),
    cfg,
    abortSignal: abort.signal,
    statusPatchSink: (next) => {
      if (next.lifecycle === "ready") {
        ready[readyCount]?.resolve();
        readyCount += 1;
      }
    },
  });
  const lifecycle = startBuzzGatewayAccount(ctx);
  const stopped = lifecycle.then(() => {
    throw new Error("Buzz account stopped before becoming ready");
  });
  return {
    handled,
    ready: async (n: 0 | 1) => await Promise.race([ready[n]!.promise, stopped]),
    stop: async () => {
      abort.abort();
      await lifecycle;
    },
  };
}

it('joins a Bot-role room from a "*" entry without listing it', async () => {
  const gateway = await runGateway({ "*": { requireMention: false } });
  try {
    await gateway.ready(0);
    fixture.sendMessage("auto-joined");
    await vi.waitFor(() => expect(gateway.handled).toContain("auto-joined"));
  } finally {
    await gateway.stop();
  }
}, 15000);

it("keeps a room disabled explicitly out of auto-join", async () => {
  const gateway = await runGateway({
    "*": { requireMention: false },
    [fixture.roomId]: { enabled: false },
  });
  try {
    await gateway.ready(0);
    fixture.sendMessage("disabled room");
    await delay(500);
    expect(gateway.handled).toEqual([]);
  } finally {
    await gateway.stop();
  }
}, 15000);

it("does not join a room where the bot is only a member", async () => {
  setRosterRole("member", Math.floor(Date.now() / 1000));
  const gateway = await runGateway({ "*": { requireMention: false } });
  try {
    await gateway.ready(0);
    fixture.sendMessage("member only");
    await delay(500);
    expect(gateway.handled).toEqual([]);
  } finally {
    await gateway.stop();
  }
}, 15000);

it("starts a room live when the bot is added with the Bot role", async () => {
  const startedAt = Math.floor(Date.now() / 1000);
  setRosterRole("member", startedAt);
  const gateway = await runGateway({ "*": { requireMention: false } });
  try {
    await gateway.ready(0);
    fixture.broadcast(rosterEvent("bot", startedAt + 1));
    fixture.broadcast(
      fixture.signRelay({
        kind: 44_100,
        created_at: startedAt + 1,
        content: "",
        tags: [
          ["p", fixture.botPublicKey],
          ["h", fixture.roomId],
        ],
      }),
    );
    await gateway.ready(1);
    fixture.sendMessage("after add");
    await vi.waitFor(() => expect(gateway.handled).toContain("after add"));
  } finally {
    await gateway.stop();
  }
}, 20000);

it("stops an auto-joined room when the bot is removed", async () => {
  const startedAt = Math.floor(Date.now() / 1000);
  const gateway = await runGateway({ "*": { requireMention: false } });
  try {
    await gateway.ready(0);
    fixture.sendMessage("before removal");
    await vi.waitFor(() => expect(gateway.handled).toContain("before removal"));
    fixture.broadcast(
      fixture.signRelay({
        kind: 39002,
        created_at: startedAt + 1,
        content: "",
        tags: [
          ["d", fixture.roomId],
          ["p", fixture.senderPublicKey, "", "member"],
        ],
      }),
    );
    fixture.broadcast(
      fixture.signRelay({
        kind: 44_101,
        created_at: startedAt + 1,
        content: "",
        tags: [
          ["p", fixture.botPublicKey],
          ["h", fixture.roomId],
        ],
      }),
    );
    await delay(1500);
    fixture.sendMessage("after removal");
    await delay(1000);
    expect(gateway.handled).toEqual(["before removal"]);
  } finally {
    await gateway.stop();
  }
}, 20000);
