import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyEvent, type Event } from "nostr-tools";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUZZ_MEDIA_FAILED_NOTE, prepareBuzzMediaMessage } from "./media.runtime.js";
import { resolveBuzzAccount } from "./types.js";

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const MEDIA_ROOT = "/tmp/buzz-media-test";

type UploadRequest = {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
};

let server: Server;
let origin: string;
let uploads: UploadRequest[];
let respond: (request: UploadRequest) => { status: number; body: unknown };

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function blobDescriptor(request: UploadRequest) {
  const sha256 = createHash("sha256").update(request.body).digest("hex");
  return {
    url: `${origin}/media/${sha256}.png`,
    sha256,
    size: request.body.length,
    type: "image/png",
    uploaded: 1,
    dim: "1x1",
  };
}

function prepare(mediaUrls: string[], text = "New figure listed", file = PNG) {
  const cfg = {
    channels: { buzz: { relayUrl: origin.replace("http:", "ws:"), privateKey: "1".repeat(64) } },
  } as OpenClawConfig;
  return prepareBuzzMediaMessage({
    cfg,
    account: resolveBuzzAccount({ cfg }),
    text,
    mediaUrls,
    mediaLocalRoots: [MEDIA_ROOT],
    mediaReadFile: async () => file,
  });
}

beforeEach(async () => {
  uploads = [];
  respond = (request) => ({ status: 200, body: blobDescriptor(request) });
  server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const upload = { method: request.method, url: request.url, headers: request.headers, body };
      uploads.push(upload);
      const reply = respond(upload);
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe("prepareBuzzMediaMessage", () => {
  it("uploads with a signed Blossom grant and references the blob in imeta", async () => {
    const message = await prepare([`${MEDIA_ROOT}/figure.png`]);

    expect(uploads).toHaveLength(1);
    const [upload] = uploads;
    if (!upload) {
      throw new Error("expected one Buzz media upload");
    }
    const sha256 = createHash("sha256").update(upload.body).digest("hex");
    expect(upload.method).toBe("PUT");
    expect(upload.url).toBe("/upload");
    expect(upload.headers["x-sha-256"]).toBe(sha256);
    expect(upload.headers["content-type"]).toBe("image/png");

    const authorization = String(upload.headers.authorization);
    expect(authorization.startsWith("Nostr ")).toBe(true);
    const grant = JSON.parse(
      Buffer.from(authorization.slice("Nostr ".length), "base64").toString("utf8"),
    ) as Event;
    expect(verifyEvent(grant)).toBe(true);
    expect(grant.kind).toBe(24_242);
    expect(grant.tags).toEqual(
      expect.arrayContaining([
        ["t", "upload"],
        ["x", sha256],
        // The relay binds the grant to its host, so a non-default port must survive.
        ["server", new URL(origin).host],
      ]),
    );

    const url = `${origin}/media/${sha256}.png`;
    expect(message).toEqual({
      text: `New figure listed\n![image](${url})`,
      imetaTags: [
        [
          "imeta",
          `url ${url}`,
          "m image/png",
          `x ${sha256}`,
          `size ${upload.body.length}`,
          "dim 1x1",
        ],
      ],
    });
  });

  it("strips image metadata before upload", async () => {
    // A tEXt chunk before IEND, which Buzz relays refuse with HTTP 422.
    const comment = Buffer.from("0000000a74455874436f6d6d656e74006869a1b2c3d4", "hex");
    const tagged = Buffer.concat([PNG.subarray(0, -12), comment, PNG.subarray(-12)]);

    await prepare([`${MEDIA_ROOT}/tagged.png`], "New figure listed", tagged);

    expect(uploads[0]?.body.equals(PNG)).toBe(true);
  });

  it("keeps the reply and notes the attachment when the relay rejects it", async () => {
    respond = (request) =>
      uploads.length === 1
        ? { status: 200, body: blobDescriptor(request) }
        : { status: 415, body: { error: "unsupported media type" } };

    const message = await prepare([`${MEDIA_ROOT}/first.png`, `${MEDIA_ROOT}/second.png`]);

    expect(uploads).toHaveLength(2);
    expect(message.imetaTags).toHaveLength(1);
    expect(message.text.split("\n")).toEqual([
      "New figure listed",
      expect.stringMatching(/^!\[image\]\(http:\/\/127\.0\.0\.1:\d+\/media\/[0-9a-f]{64}\.png\)$/u),
      BUZZ_MEDIA_FAILED_NOTE,
    ]);
  });

  it("refuses a descriptor that points outside the relay media store", async () => {
    respond = (request) => ({
      status: 200,
      body: { ...blobDescriptor(request), url: "https://elsewhere.example/media/x.png" },
    });

    const message = await prepare([`${MEDIA_ROOT}/figure.png`], "");

    expect(message).toEqual({ text: BUZZ_MEDIA_FAILED_NOTE, imetaTags: [] });
  });
});
