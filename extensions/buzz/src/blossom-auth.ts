import { finalizeEvent } from "nostr-tools";

const BLOSSOM_AUTH_KIND = 24_242;
const BLOSSOM_AUTH_TTL_SECONDS = 60;

const BLOSSOM_AUTH_CONTENT = {
  upload: "Upload file",
  get: "Get file",
} as const;

/** The relay's HTTP origin for a Buzz websocket relay URL. */
export function resolveBuzzRelayHttpUrl(relayUrl: string): URL {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url;
}

/**
 * Signs a Blossom (kind 24242) proof scoped to one blob. Buzz relays require one
 * for every upload and every media read, and check the signer's membership.
 */
export function buildBlossomAuthorization(params: {
  verb: keyof typeof BLOSSOM_AUTH_CONTENT;
  secretKey: Uint8Array;
  sha256: string;
  server: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const event = finalizeEvent(
    {
      kind: BLOSSOM_AUTH_KIND,
      content: BLOSSOM_AUTH_CONTENT[params.verb],
      created_at: now,
      tags: [
        ["t", params.verb],
        ["x", params.sha256],
        ["expiration", String(now + BLOSSOM_AUTH_TTL_SECONDS)],
        // The relay binds media auth to its tenant host, port included.
        ["server", params.server],
      ],
    },
    params.secretKey,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}
