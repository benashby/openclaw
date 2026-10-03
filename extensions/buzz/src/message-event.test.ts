import type { Event } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { BUZZ_NORMAL_MESSAGE_KIND, parseBuzzMessageEvent } from "./message-event.js";

const ROOM_ID = "b25b8e40-eb1a-43a4-b56b-30a4e16df586";
const SHA256 = "fc4525ddc43e84d46444c684bad10cbb197c5baa53e0adb9e19d6f914a461d6b";
const MEDIA_URL = `https://buzz.example.ts.net/media/${SHA256}.png`;

function messageEvent(content: string, tags: string[][] = []): Event {
  return {
    id: "e".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1_777_000_000,
    kind: BUZZ_NORMAL_MESSAGE_KIND,
    tags: [["h", ROOM_ID], ...tags],
    content,
    sig: "0".repeat(128),
  };
}

describe("parseBuzzMessageEvent media", () => {
  it("reads an attachment from its imeta tag", () => {
    const message = parseBuzzMessageEvent(
      messageEvent(`tell me about this image\n![image](${MEDIA_URL})`, [
        [
          "imeta",
          `url ${MEDIA_URL}`,
          "m image/png",
          `x ${SHA256}`,
          "size 10037753",
          "dim 1920x1080",
          "blurhash LEHV6nWB2yk8",
        ],
      ]),
    );

    expect(message?.media).toEqual([
      {
        url: MEDIA_URL,
        sha256: SHA256,
        mimeType: "image/png",
        size: 10_037_753,
        width: 1920,
        height: 1080,
      },
    ]);
  });

  it("drops imeta tags without a URL or a valid sha256", () => {
    const message = parseBuzzMessageEvent(
      messageEvent("hello", [
        ["imeta", `x ${SHA256}`, "m image/png"],
        ["imeta", `url ${MEDIA_URL}`, "x not-a-hash"],
      ]),
    );

    expect(message?.text).toBe("hello");
    expect(message?.media).toBeUndefined();
  });

  it("keeps an attachment-only message and still drops an empty one", () => {
    const attachmentOnly = parseBuzzMessageEvent(
      messageEvent("", [["imeta", `url ${MEDIA_URL}`, `x ${SHA256}`]]),
    );

    expect(attachmentOnly?.media).toHaveLength(1);
    expect(parseBuzzMessageEvent(messageEvent("  "))).toBeNull();
  });

  it("caps the number of attachments read from one message", () => {
    const tags = Array.from({ length: 12 }, () => ["imeta", `url ${MEDIA_URL}`, `x ${SHA256}`]);

    expect(parseBuzzMessageEvent(messageEvent("many", tags))?.media).toHaveLength(10);
  });
});
