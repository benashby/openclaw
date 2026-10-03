import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import type { OutboundMediaLoadOptions } from "openclaw/plugin-sdk/outbound-media";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { computeBackoff, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { sendBuzzTextOneShot, startBuzzBus, type BuzzBus } from "./buzz-bus.js";
import { handleBuzzInbound } from "./inbound.js";
import { openBuzzRecoveryWatermarkStore, resolveBuzzRecoverySince } from "./recovery-watermark.js";
import {
  isBuzzAutoJoinEnabled,
  listDisabledBuzzRoomIds,
  listExplicitBuzzRoomIds,
  mergeAutoJoinedBuzzRoomIds,
  resolveBuzzRoomConfig,
} from "./room-config.js";
import { discoverBuzzRooms } from "./room-discovery.js";
import { getBuzzRuntime } from "./runtime.js";
import { BUZZ_MAX_CONFIGURED_ROOMS } from "./subscription-budget.js";
import { buildBuzzTarget, isConfiguredBuzzChannel, parseBuzzTarget } from "./target.js";
import {
  assertBuzzAccountAvailable,
  resolveBuzzAccount,
  resolveBuzzAccountConfig,
  type ResolvedBuzzAccount,
} from "./types.js";

const activeBuses = new Map<string, BuzzBus>();
const RECONNECT_BACKOFF = {
  initialMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
} as const;
const RECONNECT_STABLE_MS = 60_000;
const RECONNECT_LOOKBACK_SECONDS = 24 * 60 * 60;

export function getActiveBuzzBus(accountId: string): BuzzBus | undefined {
  return activeBuses.get(accountId);
}

function resolveBuzzProfileName(params: {
  cfg: OpenClawConfig;
  account: ResolvedBuzzAccount;
  channelIds: string[];
}): string {
  const explicitName = params.account.config.name?.trim();
  if (explicitName) {
    return explicitName;
  }
  const runtime = getBuzzRuntime();
  const agentIds = new Set(
    params.channelIds.map(
      (channelId) =>
        runtime.channel.routing.resolveAgentRoute({
          cfg: params.cfg,
          channel: "buzz",
          accountId: params.account.accountId,
          peer: { kind: "group", id: buildBuzzTarget(channelId) },
        }).agentId,
    ),
  );
  if (agentIds.size !== 1) {
    return "OpenClaw";
  }
  const agentId = agentIds.values().next().value;
  return agentId
    ? runtime.agent.resolveAgentIdentity(params.cfg, agentId)?.name?.trim() || "OpenClaw"
    : "OpenClaw";
}

async function resolveAutoJoinedChannelIds(params: {
  account: ResolvedBuzzAccount;
  explicitChannelIds: string[];
  disabledChannelIds: string[];
  signal: AbortSignal;
  onDropped: (dropped: number) => void;
}): Promise<string[]> {
  const rooms = await discoverBuzzRooms({
    relayUrl: params.account.relayUrl,
    privateKey: params.account.privateKey,
    authTag: params.account.authTag,
    signal: params.signal,
  });
  const { roomIds, dropped } = mergeAutoJoinedBuzzRoomIds({
    explicitRoomIds: params.explicitChannelIds,
    discoveredRoomIds: rooms.map((room) => parseBuzzTarget(room.id)),
    disabledRoomIds: params.disabledChannelIds,
    maxRooms: BUZZ_MAX_CONFIGURED_ROOMS,
  });
  if (dropped > 0) {
    params.onDropped(dropped);
  }
  return roomIds;
}

export async function startBuzzGatewayAccount(ctx: ChannelGatewayContext<ResolvedBuzzAccount>) {
  const channelRuntime = ctx.channelRuntime as PluginRuntime["channel"] | undefined;
  const buildContext = channelRuntime?.inbound.buildContext;
  const account = ctx.account;
  assertBuzzAccountAvailable(account);
  if (!account.configured) {
    throw new Error(`Buzz is not configured for account "${account.accountId}"`);
  }
  const autoJoin = isBuzzAutoJoinEnabled(account.config.groups);
  const explicitChannelIds = listExplicitBuzzRoomIds(account.config.groups).map(parseBuzzTarget);
  const disabledChannelIds = listDisabledBuzzRoomIds(account.config.groups).map(parseBuzzTarget);
  if (explicitChannelIds.length === 0 && !autoJoin) {
    const { configPath } = resolveBuzzAccountConfig({
      cfg: ctx.cfg,
      accountId: account.accountId,
    });
    throw new Error(`Buzz requires at least one enabled ${configPath}.groups entry`);
  }

  const watermarkStore = openBuzzRecoveryWatermarkStore({ accountId: account.accountId });

  let reconnectAttempt = 0;
  while (!ctx.abortSignal.aborted) {
    const historyMap = new Map<string, HistoryEntry[]>();
    let bus: BuzzBus | undefined;
    let cycleError: Error | undefined;
    let connectedAt: number | undefined;
    const { promise: busFailure, resolve: reportBusFailure } = createDeferred<Error>();
    try {
      // With a "*" entry the room set is rebuilt from the relay on every cycle, so a
      // membership notification that triggers a rebuild picks up newly added rooms.
      const channelIds = autoJoin
        ? await resolveAutoJoinedChannelIds({
            account,
            explicitChannelIds,
            disabledChannelIds,
            signal: ctx.abortSignal,
            onDropped: (dropped) => {
              ctx.log?.warn?.(
                `[${account.accountId}] Buzz auto-join skipped ${dropped} room(s) over the ${BUZZ_MAX_CONFIGURED_ROOMS}-room limit`,
              );
            },
          })
        : explicitChannelIds;
      const configuredChannelIds = new Set(channelIds);
      const profileName = resolveBuzzProfileName({ cfg: ctx.cfg, account, channelIds });
      const nowSeconds = Math.floor(Date.now() / 1000);
      const sinceByRoom = await resolveBuzzRecoverySince({
        store: watermarkStore,
        channelIds,
        nowSeconds,
        lookbackSeconds: RECONNECT_LOOKBACK_SECONDS,
      });
      bus = await startBuzzBus({
        accountId: account.accountId,
        relayUrl: account.relayUrl,
        privateKey: account.privateKey,
        authTag: account.authTag,
        profileName,
        channelIds,
        autoJoin,
        ignoredRoomIds: disabledChannelIds,
        since: (channelId) => sinceByRoom.get(channelId) ?? nowSeconds,
        signal: ctx.abortSignal,
        onMessage: async (message, sessionBus, signal, assertCurrent) => {
          // Subscription filters reduce traffic, but relay events remain untrusted.
          if (!isConfiguredBuzzChannel(configuredChannelIds, message.channelId)) {
            return;
          }
          await handleBuzzInbound({
            account,
            cfg: ctx.cfg,
            bus: sessionBus,
            message,
            signal,
            assertCurrent,
            historyMap,
            buildContext,
          });
        },
        onMessageError: (error) => {
          ctx.log?.error?.(`[${account.accountId}] Buzz message failed: ${error.message}`);
        },
        onFatalError: (error) => {
          ctx.log?.error?.(`[${account.accountId}] Buzz bus failed: ${error.message}`);
          reportBusFailure(error);
        },
        onDedupeError: (error) => {
          ctx.log?.error?.(`[${account.accountId}] Buzz replay state failed: ${error.message}`);
        },
        onHistoryError: (error) => {
          ctx.log?.warn?.(
            `[${account.accountId}] Buzz history recovery incomplete: ${error.message}`,
          );
        },
        onRoomUnavailable: (error) => {
          ctx.log?.warn?.(`[${account.accountId}] Buzz room skipped: ${error.message}`);
        },
        onPresenceError: (error) => {
          ctx.log?.warn?.(
            `[${account.accountId}] Buzz presence heartbeat failed: ${error.message}`,
          );
        },
        onProfilePublished: () => {
          ctx.log?.info?.(`[${account.accountId}] Buzz bot profile published as "${profileName}"`);
        },
        onProfileError: (error) => {
          ctx.log?.warn?.(`[${account.accountId}] Buzz bot profile sync failed: ${error.message}`);
        },
        onDirectoryError: (error) => {
          ctx.log?.warn?.(`[${account.accountId}] Buzz directory refresh failed: ${error.message}`);
        },
        onRoomDirectoryChanged: ctx.invalidateDirectoryCache,
      });
      ctx.invalidateDirectoryCache?.();
      connectedAt = Date.now();
      activeBuses.set(account.accountId, bus);
      ctx.setStatus(
        channelReadyPatch({
          accountId: account.accountId,
          configured: true,
          enabled: account.enabled,
          baseUrl: account.relayUrl,
          publicKey: bus.publicKey,
        }),
      );
      ctx.log?.info?.(
        `[${account.accountId}] Buzz connected to ${account.relayUrl} for ${bus.directory.activeRoomIds().length} channel(s)`,
      );
      const fatalError = await Promise.race([
        waitUntilAbort(ctx.abortSignal).then(() => undefined),
        busFailure,
      ]);
      if (fatalError) {
        throw fatalError;
      }
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        return;
      }
      cycleError = error instanceof Error ? error : new Error(String(error));
    } finally {
      // Retire before fallible async shutdown so new work cannot reacquire this bus.
      if (activeBuses.get(account.accountId) === bus) {
        activeBuses.delete(account.accountId);
      }
      await bus?.close();
      historyMap.clear();
      ctx.setStatus({
        accountId: account.accountId,
        running: false,
        ...(cycleError ? { lifecycle: "recovering" as const } : {}),
        ...(cycleError ? { lastError: cycleError.message } : {}),
      });
    }
    if (!cycleError || ctx.abortSignal.aborted) {
      return;
    }
    if (connectedAt !== undefined && Date.now() - connectedAt >= RECONNECT_STABLE_MS) {
      reconnectAttempt = 0;
    }
    reconnectAttempt += 1;
    const delayMs = computeBackoff(RECONNECT_BACKOFF, reconnectAttempt);
    ctx.log?.info?.(
      `[${account.accountId}] Buzz reconnecting in ${delayMs}ms after: ${cycleError.message}`,
    );
    try {
      await sleepWithAbort(delayMs, ctx.abortSignal);
    } catch {
      if (!ctx.abortSignal.aborted) {
        throw cycleError;
      }
    }
  }
}

type BuzzOutboundParams = {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  accountId?: string | null;
  threadId?: string | number | null;
  replyToId?: string | number | null;
};

type BuzzOutboundMediaParams = BuzzOutboundParams & {
  mediaUrl?: string;
  mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
  mediaLocalRoots?: OutboundMediaLoadOptions["mediaLocalRoots"];
  mediaReadFile?: OutboundMediaLoadOptions["mediaReadFile"];
};

async function sendBuzzOutbound(
  params: BuzzOutboundMediaParams,
  mediaUrls: readonly string[] = [],
) {
  const runtime = getBuzzRuntime();
  const account = resolveBuzzAccount({ cfg: params.cfg, accountId: params.accountId });
  const resolvedAccountId = account.accountId;
  assertBuzzAccountAvailable(account);
  if (!account.enabled) {
    throw new Error(`Buzz is disabled for account ${resolvedAccountId}`);
  }
  if (!account.configured) {
    throw new Error(`Buzz is not configured for account ${resolvedAccountId}`);
  }
  const bus = activeBuses.get(resolvedAccountId);
  const channelId = parseBuzzTarget(params.to);
  const tableMode = runtime.channel.text.resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "buzz",
    accountId: resolvedAccountId,
  });
  const text = runtime.channel.text.convertMarkdownTables(params.text ?? "", tableMode);
  const media =
    mediaUrls.length > 0
      ? await (
          await import("./media.runtime.js")
        ).prepareBuzzMediaMessage({
          cfg: params.cfg,
          account,
          text,
          mediaUrls,
          mediaAccess: params.mediaAccess,
          mediaLocalRoots: params.mediaLocalRoots,
          mediaReadFile: params.mediaReadFile,
        })
      : { text, imetaTags: undefined };
  const outboundMessage = {
    channelId,
    text: media.text,
    threadId: params.threadId == null ? undefined : String(params.threadId),
    replyToId: params.replyToId == null ? undefined : String(params.replyToId),
    imetaTags: media.imetaTags,
  };
  const messageId = bus
    ? await bus.sendText(outboundMessage)
    : await sendBuzzTextOneShot({
        relayUrl: account.relayUrl,
        privateKey: account.privateKey,
        authTag: account.authTag,
        ...outboundMessage,
      });
  return attachChannelToResult("buzz", { to: channelId, messageId });
}

export const buzzOutboundAdapter = {
  deliveryMode: "direct" as const,
  textChunkLimit: 16_000,
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  sendText: async (params: BuzzOutboundParams) => await sendBuzzOutbound(params),
  sendMedia: async (params: BuzzOutboundMediaParams) =>
    await sendBuzzOutbound(params, params.mediaUrl ? [params.mediaUrl] : []),
};

export async function sendBuzzTyping(params: {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
}): Promise<void> {
  const account = resolveBuzzAccountConfig(params);
  if (!account.config.enabled) {
    return;
  }
  const bus = activeBuses.get(account.accountId);
  if (!bus) {
    return;
  }
  const channelId = parseBuzzTarget(params.to);
  const replyToMode =
    resolveBuzzRoomConfig(account.config.groups, channelId)?.replyToMode ??
    account.config.replyToMode;
  await bus.sendTyping({
    channelId,
    threadId:
      replyToMode === "off" || params.threadId == null ? undefined : String(params.threadId),
  });
}
