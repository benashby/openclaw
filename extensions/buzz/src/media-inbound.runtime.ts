import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/account-helpers";
import {
  toInboundMediaFacts,
  type ChannelInboundMediaInput,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { ssrfPolicyFromHttpBaseUrlAllowedOrigin } from "openclaw/plugin-sdk/ssrf-runtime";
import { buildBlossomAuthorization, resolveBuzzRelayHttpUrl } from "./blossom-auth.js";
import type { BuzzInboundMediaRef, BuzzInboundMessage } from "./message-event.js";
import { parseBuzzAuthTag } from "./relay-auth.js";
import { decodeBuzzPrivateKey, type ResolvedBuzzAccount } from "./types.js";

// Same ceiling as outbound media; larger attachments are skipped, not truncated.
const BUZZ_INBOUND_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const BUZZ_MEDIA_DOWNLOAD_TIMEOUT_MS = 120_000;

const log = createSubsystemLogger("buzz/media");

export type BuzzInboundMediaFacts = ReturnType<typeof toInboundMediaFacts>;

/**
 * Accepts only blobs in the account's own relay media store, named by the hash
 * the `imeta` tag declares, so a signed read proof never leaves that relay.
 */
function resolveBuzzRelayMediaUrl(ref: BuzzInboundMediaRef, relayHttpUrl: URL): URL {
  const url = new URL(ref.url);
  const [, mediaDir, fileName, ...rest] = url.pathname.split("/");
  if (
    url.origin !== relayHttpUrl.origin ||
    mediaDir !== "media" ||
    rest.length > 0 ||
    fileName?.split(".")[0]?.toLowerCase() !== ref.sha256
  ) {
    throw new Error("Buzz attachment URL is not a blob in this relay's media store");
  }
  return url;
}

async function downloadBuzzMedia(params: {
  account: ResolvedBuzzAccount;
  ref: BuzzInboundMediaRef;
  relayHttpUrl: URL;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<ChannelInboundMediaInput> {
  const url = resolveBuzzRelayMediaUrl(params.ref, params.relayHttpUrl);
  const authTag = parseBuzzAuthTag(params.account.authTag);
  const saved = await saveRemoteMedia({
    url: url.href,
    requestInit: {
      headers: {
        Authorization: buildBlossomAuthorization({
          verb: "get",
          secretKey: decodeBuzzPrivateKey(params.account.privateKey),
          sha256: params.ref.sha256,
          server: params.relayHttpUrl.host,
        }),
        ...(authTag ? { "X-Auth-Tag": JSON.stringify(authTag) } : {}),
      },
      signal: params.signal,
    },
    maxBytes: params.maxBytes,
    timeoutMs: BUZZ_MEDIA_DOWNLOAD_TIMEOUT_MS,
    ssrfPolicy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(params.relayHttpUrl.href),
    filePathHint: params.ref.fileName ?? url.pathname,
    fallbackContentType: params.ref.mimeType,
    originalFilename: params.ref.fileName,
  });
  return {
    path: saved.path,
    contentType: saved.contentType ?? params.ref.mimeType,
    fileName: params.ref.fileName ?? saved.fileName,
    width: params.ref.width,
    height: params.ref.height,
  };
}

/**
 * Downloads a message's attachments from the relay, signed with the account's
 * key, and returns them as inbound media facts. An attachment that fails is
 * logged and left out, so the message still reaches the agent.
 */
export async function resolveBuzzInboundMedia(params: {
  cfg: OpenClawConfig;
  account: ResolvedBuzzAccount;
  message: BuzzInboundMessage;
  signal: AbortSignal;
}): Promise<BuzzInboundMediaFacts> {
  const refs = params.message.media ?? [];
  if (refs.length === 0) {
    return [];
  }
  const relayHttpUrl = resolveBuzzRelayHttpUrl(params.account.relayUrl);
  const maxBytes = Math.min(
    resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId: params.account.accountId,
      resolveChannelLimitMb: () => undefined,
    }) ?? BUZZ_INBOUND_MEDIA_MAX_BYTES,
    BUZZ_INBOUND_MEDIA_MAX_BYTES,
  );
  const media: ChannelInboundMediaInput[] = [];
  for (const ref of refs) {
    if (ref.size !== undefined && ref.size > maxBytes) {
      log.warn(
        `[${params.account.accountId}] Buzz attachment skipped: ${ref.size} bytes exceeds ${maxBytes}`,
      );
      continue;
    }
    try {
      media.push(
        await downloadBuzzMedia({
          account: params.account,
          ref,
          relayHttpUrl,
          maxBytes,
          signal: params.signal,
        }),
      );
    } catch (error) {
      if (params.signal.aborted) {
        throw error;
      }
      log.warn(
        `[${params.account.accountId}] Buzz attachment download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return toInboundMediaFacts(media, { messageId: params.message.id });
}
