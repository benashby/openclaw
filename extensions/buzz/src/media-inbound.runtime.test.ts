import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyEvent, type Event } from "nostr-tools";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBuzzInboundMedia } from "./media-inbound.runtime.js";
import {
  BUZZ_NORMAL_MESSAGE_KIND,
  type BuzzInboundMediaRef,
  type BuzzInboundMessage,
} from "./message-event.js";
import { resolveBuzzAccount } from "./types.js";

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_SHA256 = createHash("sha256").update(PNG).digest("hex");

let server: Server;
let origin: string;
let requests: { url?: string; headers: IncomingMessage["headers"]; auth?: Event }[];

function decodeAuth(header: string | undefined): Event | undefined {
  if (!header?.startsWith("Nostr ")) {
    return undefined;
  }
  return JSON.parse(Buffer.from(header.slice("Nostr ".length), "base64").toString("utf8"));
}

function tagValues(event: Event, name: string): string[] {
  return event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1] ?? "");
}

// Mirrors the relay's read check: a signed kind 24242 `get` proof for this blob and host.
function isValidReadProof(event: Event | undefined, sha256: string, host: string): boolean {
  if (!event || event.kind !== 24_242 || !event.content.trim() || !verifyEvent(event)) {
    return false;
  }
  const expiration = Number(tagValues(event, "expiration")[0]);
  return (
    tagValues(event, "t").join(",") === "get" &&
    tagValues(event, "x").join(",") === sha256 &&
    tagValues(event, "server").join(",") === host &&
    expiration > Date.now() / 1000
  );
}

function mediaRef(overrides: Partial<BuzzInboundMediaRef> = {}): BuzzInboundMediaRef {
  return {
    url: `${origin}/media/${PNG_SHA256}.png`,
    sha256: PNG_SHA256,
    mimeType: "image/png",
    size: PNG.length,
    width: 1,
    height: 1,
    ...overrides,
  };
}

function resolve(media: BuzzInboundMediaRef[], signal = new AbortController().signal) {
  const cfg = {
    channels: { buzz: { relayUrl: origin.replace("http:", "ws:"), privateKey: "1".repeat(64) } },
  } as OpenClawConfig;
  const message: BuzzInboundMessage = {
    id: "e".repeat(64),
    kind: BUZZ_NORMAL_MESSAGE_KIND,
    senderPubkey: "b".repeat(64),
    text: "tell me about this image",
    channelId: "b25b8e40-eb1a-43a4-b56b-30a4e16df586",
    createdAt: 1,
    mentionedPubkeys: [],
    media,
  };
  return resolveBuzzInboundMedia({ cfg, account: resolveBuzzAccount({ cfg }), message, signal });
}

beforeEach(async () => {
  requests = [];
  server = createServer((request, response) => {
    const auth = decodeAuth(request.headers.authorization);
    requests.push({ url: request.url, headers: request.headers, auth });
    if (!isValidReadProof(auth, PNG_SHA256, request.headers.host ?? "")) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end('{"error":"authentication failed"}');
      return;
    }
    if (request.url !== `/media/${PNG_SHA256}.png`) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(PNG);
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
});

describe("resolveBuzzInboundMedia", () => {
  it("downloads an attachment with a signed read proof and returns it as media", async () => {
    const media = await resolve([mediaRef()]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.auth?.pubkey).toBe(
      resolveBuzzAccount({
        cfg: { channels: { buzz: { privateKey: "1".repeat(64) } } } as OpenClawConfig,
      }).publicKey,
    );
    expect(media).toEqual([
      expect.objectContaining({
        contentType: "image/png",
        kind: "image",
        messageId: "e".repeat(64),
        width: 1,
        height: 1,
      }),
    ]);
    expect(await readFile(media[0]?.path as string)).toEqual(PNG);
  });

  it("never sends a proof outside the relay's media store", async () => {
    const media = await resolve([
      mediaRef({ url: `https://example.com/media/${PNG_SHA256}.png` }),
      mediaRef({ url: `${origin}/upload/${PNG_SHA256}.png` }),
      mediaRef({ url: `${origin}/media/${"f".repeat(64)}.png` }),
    ]);

    expect(requests).toEqual([]);
    expect(media).toEqual([]);
  });

  it("skips an attachment the relay refuses and keeps the rest", async () => {
    const missing = "d".repeat(64);
    const media = await resolve([
      mediaRef({ url: `${origin}/media/${missing}.png`, sha256: missing }),
      mediaRef(),
    ]);

    expect(requests).toHaveLength(2);
    expect(media).toHaveLength(1);
    expect(media[0]?.contentType).toBe("image/png");
  });

  it("skips an attachment declared larger than the media limit without fetching it", async () => {
    const media = await resolve([mediaRef({ size: 51 * 1024 * 1024 })]);

    expect(requests).toEqual([]);
    expect(media).toEqual([]);
  });
});
