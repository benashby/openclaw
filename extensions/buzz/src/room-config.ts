import type { BuzzConfig } from "./config-schema.js";

// A `groups["*"]` entry turns on auto-join: every room where the bot holds the
// Bot role is live with these settings, and an explicit room entry overrides
// them field by field.
export const BUZZ_ALL_ROOMS_KEY = "*";

type BuzzGroups = BuzzConfig["groups"];
export type BuzzRoomConfig = NonNullable<BuzzGroups>[string];

export function isBuzzAutoJoinEnabled(groups: BuzzGroups): boolean {
  const wildcard = groups?.[BUZZ_ALL_ROOMS_KEY];
  return wildcard !== undefined && wildcard.enabled !== false;
}

/** Enabled rooms named explicitly in config, without the `"*"` entry. */
export function listExplicitBuzzRoomIds(groups: BuzzGroups): string[] {
  return Object.entries(groups ?? {})
    .filter(([roomId, config]) => roomId !== BUZZ_ALL_ROOMS_KEY && config.enabled !== false)
    .map(([roomId]) => roomId);
}

/** Rooms switched off explicitly; auto-join never brings them back. */
export function listDisabledBuzzRoomIds(groups: BuzzGroups): string[] {
  return Object.entries(groups ?? {})
    .filter(([roomId, config]) => roomId !== BUZZ_ALL_ROOMS_KEY && config.enabled === false)
    .map(([roomId]) => roomId);
}

/** The settings that apply in one room: `"*"` defaults, then the room's own entry. */
export function resolveBuzzRoomConfig(
  groups: BuzzGroups,
  channelId: string,
): BuzzRoomConfig | undefined {
  const wildcard = groups?.[BUZZ_ALL_ROOMS_KEY];
  const room = groups?.[channelId];
  if (!wildcard && !room) {
    return undefined;
  }
  const { enabled: _wildcardEnabled, ...defaults } = wildcard ?? {};
  return { ...defaults, ...room };
}

/**
 * Explicit rooms first, then auto-joined rooms the bot holds the Bot role in,
 * minus explicitly disabled rooms, capped at `maxRooms`.
 */
export function mergeAutoJoinedBuzzRoomIds(params: {
  explicitRoomIds: readonly string[];
  discoveredRoomIds: readonly string[];
  disabledRoomIds: readonly string[];
  maxRooms: number;
}): { roomIds: string[]; dropped: number } {
  const disabled = new Set(params.disabledRoomIds);
  const roomIds = [...new Set([...params.explicitRoomIds, ...params.discoveredRoomIds])].filter(
    (roomId) => !disabled.has(roomId),
  );
  return {
    roomIds: roomIds.slice(0, params.maxRooms),
    dropped: Math.max(0, roomIds.length - params.maxRooms),
  };
}
