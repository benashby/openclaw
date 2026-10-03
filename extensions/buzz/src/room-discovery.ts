import type { Event, Filter, Relay } from "nostr-tools";
import { isNewerBuzzRevision } from "./event-order.js";
import { connectAuthenticatedBuzzRelaySession, parseBuzzAuthTag } from "./relay-auth.js";
import { queryBuzzRelaySnapshot } from "./relay-subscription.js";
import { BUZZ_ROOM_MEMBERSHIP_KIND, parseBuzzRoomMembershipEvent } from "./room-membership.js";
import { BUZZ_CHANNEL_ID_PATTERN } from "./target.js";
import { decodeBuzzPrivateKey, resolveBuzzPublicKey } from "./types.js";

const METADATA_KIND = 39000;
const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

export type BuzzDiscoveredRoom = {
  id: string;
  name: string;
  about?: string;
  /** A direct-message room the bot holds a plain member role in, not the Bot role. */
  direct?: true;
};

/** Buzz marks a direct-message room with a `t` tag of `dm` in its kind-39000 metadata. */
export function isBuzzDirectMessageRoomMetadata(event: Pick<Event, "tags">): boolean {
  return event.tags.some((tag) => tag[0] === "t" && tag[1] === "dm");
}

function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

async function queryRelay(params: {
  relay: Relay;
  filter: Filter;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<Event[]> {
  params.signal?.throwIfAborted();
  const events: Event[] = [];
  return await queryBuzzRelaySnapshot({
    relay: params.relay,
    filters: [params.filter],
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    timeoutMessage: "Timed out querying Buzz room membership",
    abortMessage: "Buzz room query aborted",
    failureMessage: "Buzz room query failed",
    closeReason: "query complete",
    closeMessage: (reason) => `Buzz room query closed: ${reason}`,
    onEvent: (event) => events.push(event),
    result: () => events,
  });
}

export async function discoverBuzzRoomsOnRelay(params: {
  relay: Relay;
  relayPublicKey: string;
  publicKey: string;
  /**
   * Also return DM rooms where the bot is a plain member. Buzz never grants a
   * Bot role in a DM, so opening one with a bot only ever makes it a member.
   */
  includeDirectMessages?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<BuzzDiscoveredRoom[]> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const membershipEvents = await queryRelay({
    relay: params.relay,
    filter: {
      kinds: [BUZZ_ROOM_MEMBERSHIP_KIND],
      authors: [params.relayPublicKey],
      "#p": [params.publicKey],
      limit: 1000,
    },
    timeoutMs,
    signal: params.signal,
  });
  const botRoomIds = new Set<string>();
  const memberRoomIds = new Set<string>();
  for (const event of membershipEvents) {
    const membership = parseBuzzRoomMembershipEvent(event, params.relayPublicKey);
    if (!membership?.roomId.match(BUZZ_CHANNEL_ID_PATTERN)) {
      continue;
    }
    if (membership.roles.get(params.publicKey) === "bot") {
      botRoomIds.add(membership.roomId);
    } else if (params.includeDirectMessages && membership.members.has(params.publicKey)) {
      // Kept only if the metadata below says the room is a DM.
      memberRoomIds.add(membership.roomId);
    }
  }
  const roomIds = [...new Set([...botRoomIds, ...memberRoomIds])].toSorted();
  if (roomIds.length === 0) {
    return [];
  }

  const metadataEvents = await queryRelay({
    relay: params.relay,
    filter: {
      kinds: [METADATA_KIND],
      authors: [params.relayPublicKey],
      "#d": roomIds,
      limit: roomIds.length,
    },
    timeoutMs,
    signal: params.signal,
  });
  const latestMetadata = new Map<string, Event>();
  for (const event of metadataEvents) {
    const roomId = tagValue(event, "d")?.toLowerCase();
    const current = roomId ? latestMetadata.get(roomId) : undefined;
    if (
      event.kind !== METADATA_KIND ||
      event.pubkey.toLowerCase() !== params.relayPublicKey ||
      !roomId ||
      !roomIds.includes(roomId) ||
      !isNewerBuzzRevision(
        { createdAt: event.created_at, eventId: event.id },
        current ? { createdAt: current.created_at, eventId: current.id } : undefined,
      )
    ) {
      continue;
    }
    latestMetadata.set(roomId, event);
  }

  return roomIds.flatMap((id) => {
    const metadata = latestMetadata.get(id);
    if (metadata?.tags.some((tag) => tag[0] === "archived" && tag[1] === "true")) {
      return [];
    }
    const direct = !botRoomIds.has(id);
    if (direct && !(metadata && isBuzzDirectMessageRoomMetadata(metadata))) {
      return [];
    }
    const name = metadata ? tagValue(metadata, "name")?.trim() : undefined;
    const about = metadata ? tagValue(metadata, "about")?.trim() : undefined;
    const room: BuzzDiscoveredRoom = {
      id,
      name: name || id,
    };
    if (about) {
      room.about = about;
    }
    if (direct) {
      room.direct = true;
    }
    return [room];
  });
}

export async function discoverBuzzRooms(params: {
  relayUrl: string;
  privateKey: string;
  authTag?: string;
  includeDirectMessages?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<BuzzDiscoveredRoom[]> {
  const secretKey = decodeBuzzPrivateKey(params.privateKey);
  const publicKey = resolveBuzzPublicKey(params.privateKey);
  const timeoutMs = params.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  // One abort budget covers connect, NIP-42 auth, membership, and metadata.
  // Status callers must not wait for a fresh timeout at every relay phase.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
  const { relay, relayPublicKey } = await connectAuthenticatedBuzzRelaySession({
    relayUrl: params.relayUrl,
    secretKey,
    authTag: parseBuzzAuthTag(params.authTag ?? ""),
    signal,
  });

  try {
    // Buzz's relay publishes authenticated kind-39002 membership lists for room
    // discovery. Require the explicit Bot role before setup or probes accept a room;
    // only auto-join opts in to DMs, where a plain member role is all Buzz grants.
    return await discoverBuzzRoomsOnRelay({
      relay,
      relayPublicKey,
      publicKey,
      includeDirectMessages: params.includeDirectMessages,
      timeoutMs,
      signal,
    });
  } finally {
    if (relay.connected) {
      relay.close();
    }
  }
}
