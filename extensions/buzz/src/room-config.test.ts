import { describe, expect, it } from "vitest";
import {
  isBuzzAutoJoinEnabled,
  listDisabledBuzzRoomIds,
  listExplicitBuzzRoomIds,
  mergeAutoJoinedBuzzRoomIds,
  resolveBuzzRoomConfig,
} from "./room-config.js";

const ROOM = "6d882171-148b-4f89-90e8-6e058cacc498";
const OTHER = "7c509724-5bf2-4d21-8697-6b5ddc46ab3c";

describe("Buzz room config", () => {
  it('lets a room\'s own entry override "*" field by field', () => {
    const groups = {
      "*": { requireMention: true, threadSessions: true, enabled: true },
      [ROOM]: { requireMention: false },
    };

    expect(resolveBuzzRoomConfig(groups, ROOM)).toEqual({
      requireMention: false,
      threadSessions: true,
    });
    expect(resolveBuzzRoomConfig(groups, OTHER)).toEqual({
      requireMention: true,
      threadSessions: true,
    });
    expect(resolveBuzzRoomConfig({ [ROOM]: { requireMention: false } }, OTHER)).toBeUndefined();
  });

  it('treats "*" as auto-join and keeps it out of the explicit room lists', () => {
    const groups = { "*": {}, [ROOM]: {}, [OTHER]: { enabled: false } };

    expect(isBuzzAutoJoinEnabled(groups)).toBe(true);
    expect(isBuzzAutoJoinEnabled({ "*": { enabled: false } })).toBe(false);
    expect(isBuzzAutoJoinEnabled({ [ROOM]: {} })).toBe(false);
    expect(listExplicitBuzzRoomIds(groups)).toEqual([ROOM]);
    expect(listDisabledBuzzRoomIds(groups)).toEqual([OTHER]);
  });

  it("merges explicit and discovered rooms, drops disabled ones and caps the total", () => {
    expect(
      mergeAutoJoinedBuzzRoomIds({
        explicitRoomIds: [ROOM],
        discoveredRoomIds: [OTHER, ROOM, "a", "b"],
        disabledRoomIds: ["a"],
        maxRooms: 3,
      }),
    ).toEqual({ roomIds: [ROOM, OTHER, "b"], dropped: 0 });
    expect(
      mergeAutoJoinedBuzzRoomIds({
        explicitRoomIds: [ROOM],
        discoveredRoomIds: [OTHER, "b"],
        disabledRoomIds: [],
        maxRooms: 2,
      }),
    ).toEqual({ roomIds: [ROOM, OTHER], dropped: 1 });
  });
});
