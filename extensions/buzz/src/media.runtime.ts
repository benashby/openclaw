import { createHash } from "node:crypto";
import { finalizeEvent } from "nostr-tools";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/account-helpers";
import { bufferToBlobPart } from "openclaw/plugin-sdk/blob-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import {
  loadOutboundMediaFromUrl,
  type OutboundMediaLoadOptions,
} from "openclaw/plugin-sdk/outbound-media";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { parseBuzzAuthTag } from "./relay-auth.js";
import { decodeBuzzPrivateKey, type ResolvedBuzzAccount } from "./types.js";

// Matches the Buzz CLI's image ceiling; the relay stays the authority on type and size.
const BUZZ_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const BLOSSOM_AUTH_KIND = 24_242;
const BLOSSOM_AUTH_TTL_SECONDS = 60;
const BUZZ_MEDIA_UPLOAD_TIMEOUT_MS = 120_000;
// Optional NIP-92 fields the relay may describe and accepts back in `imeta`.
const OPTIONAL_IMETA_FIELDS = ["dim", "blurhash", "thumb", "duration"] as const;

export const BUZZ_MEDIA_FAILED_NOTE = "⚠️ Media failed.";

const log = createSubsystemLogger("buzz/media");

type BuzzBlobDescriptor = {
  url: string;
  sha256: string;
  size: number;
  type: string;
} & Partial<Record<(typeof OPTIONAL_IMETA_FIELDS)[number], string>>;

export type BuzzMediaMessage = {
  text: string;
  imetaTags: string[][];
};

function resolveBuzzRelayHttpUrl(relayUrl: string): URL {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url;
}

function buildBlossomUploadAuthorization(params: {
  secretKey: Uint8Array;
  sha256: string;
  server: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const event = finalizeEvent(
    {
      kind: BLOSSOM_AUTH_KIND,
      content: "Upload file",
      created_at: now,
      tags: [
        ["t", "upload"],
        ["x", params.sha256],
        ["expiration", String(now + BLOSSOM_AUTH_TTL_SECONDS)],
        // The relay binds upload auth to its tenant host, port included.
        ["server", params.server],
      ],
    },
    params.secretKey,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

function parseBuzzBlobDescriptor(
  document: Record<string, unknown>,
  expected: { origin: string; sha256: string },
): BuzzBlobDescriptor {
  const { url, sha256, size, type } = document;
  if (
    typeof url !== "string" ||
    typeof type !== "string" ||
    typeof size !== "number" ||
    sha256 !== expected.sha256
  ) {
    throw new Error("Buzz media upload returned an invalid blob descriptor");
  }
  const parsed = new URL(url);
  if (parsed.origin !== expected.origin || !parsed.pathname.startsWith("/media/")) {
    throw new Error("Buzz media upload returned a URL outside the relay media store");
  }
  const descriptor: BuzzBlobDescriptor = { url, sha256, size, type };
  for (const field of OPTIONAL_IMETA_FIELDS) {
    const value = document[field];
    if (typeof value === "string" || typeof value === "number") {
      descriptor[field] = String(value);
    }
  }
  return descriptor;
}

async function uploadBuzzBlob(params: {
  account: ResolvedBuzzAccount;
  buffer: Buffer;
  contentType: string;
}): Promise<BuzzBlobDescriptor> {
  const relayHttpUrl = resolveBuzzRelayHttpUrl(params.account.relayUrl);
  const uploadUrl = `${relayHttpUrl.href.replace(/\/+$/u, "")}/upload`;
  const sha256 = createHash("sha256").update(params.buffer).digest("hex");
  const authTag = parseBuzzAuthTag(params.account.authTag);
  const { response, release } = await fetchWithSsrFGuard({
    url: uploadUrl,
    init: {
      method: "PUT",
      headers: {
        Authorization: buildBlossomUploadAuthorization({
          secretKey: decodeBuzzPrivateKey(params.account.privateKey),
          sha256,
          server: relayHttpUrl.host,
        }),
        "Content-Type": params.contentType,
        "X-SHA-256": sha256,
        ...(authTag ? { "X-Auth-Tag": JSON.stringify(authTag) } : {}),
      },
      body: bufferToBlobPart(params.buffer),
    },
    timeoutMs: BUZZ_MEDIA_UPLOAD_TIMEOUT_MS,
    policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(uploadUrl),
    auditContext: "buzz.media_upload",
  });
  try {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Buzz media upload failed with HTTP ${response.status}`);
    }
    const document = await readProviderJsonObjectResponse(response, "Buzz media upload");
    return parseBuzzBlobDescriptor(document, { origin: relayHttpUrl.origin, sha256 });
  } finally {
    await release();
  }
}

function buildBuzzImetaTag(descriptor: BuzzBlobDescriptor): string[] {
  const tag = [
    "imeta",
    `url ${descriptor.url}`,
    `m ${descriptor.type}`,
    `x ${descriptor.sha256}`,
    `size ${descriptor.size}`,
  ];
  for (const field of OPTIONAL_IMETA_FIELDS) {
    const value = descriptor[field];
    if (value) {
      tag.push(`${field} ${value}`);
    }
  }
  return tag;
}

function formatBuzzMediaMarkdown(descriptor: BuzzBlobDescriptor): string {
  const label = descriptor.type.startsWith("video/") ? "video" : "image";
  return `![${label}](${descriptor.url})`;
}

/**
 * Uploads each attachment to the account's relay and returns the message body
 * and `imeta` tags that reference them. An attachment that cannot be loaded or
 * uploaded is left out and noted in the text, so the reply still arrives.
 */
export async function prepareBuzzMediaMessage(params: {
  cfg: OpenClawConfig;
  account: ResolvedBuzzAccount;
  text: string;
  mediaUrls: readonly string[];
  mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
  mediaLocalRoots?: OutboundMediaLoadOptions["mediaLocalRoots"];
  mediaReadFile?: OutboundMediaLoadOptions["mediaReadFile"];
}): Promise<BuzzMediaMessage> {
  const maxBytes = Math.min(
    resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId: params.account.accountId,
      resolveChannelLimitMb: () => undefined,
    }) ?? BUZZ_MEDIA_MAX_BYTES,
    BUZZ_MEDIA_MAX_BYTES,
  );
  const lines = params.text.trim() ? [params.text] : [];
  const imetaTags: string[][] = [];
  let failed = false;
  for (const mediaUrl of params.mediaUrls) {
    try {
      const media = await loadOutboundMediaFromUrl(mediaUrl, {
        maxBytes,
        mediaAccess: params.mediaAccess,
        mediaLocalRoots: params.mediaLocalRoots,
        mediaReadFile: params.mediaReadFile,
      });
      const descriptor = await uploadBuzzBlob({
        account: params.account,
        buffer: media.buffer,
        contentType: media.contentType?.trim() || "application/octet-stream",
      });
      lines.push(formatBuzzMediaMarkdown(descriptor));
      imetaTags.push(buildBuzzImetaTag(descriptor));
    } catch (error) {
      failed = true;
      log.warn(
        `[${params.account.accountId}] Buzz media attachment failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failed) {
    lines.push(BUZZ_MEDIA_FAILED_NOTE);
  }
  return { text: lines.join("\n"), imetaTags };
}
