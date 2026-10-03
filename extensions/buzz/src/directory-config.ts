import type {
  ChannelDirectoryEntry,
  DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { applyBuzzDirectoryQueryAndLimit } from "./directory-query.js";
import { listExplicitBuzzRoomIds } from "./room-config.js";
import { buildBuzzTarget, parseBuzzTarget } from "./target.js";
import { resolveBuzzAccount } from "./types.js";

export async function listBuzzDirectoryPeersFromConfig(
  _params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  return [];
}

export async function listBuzzDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveBuzzAccount({ cfg: params.cfg, accountId: params.accountId });
  const entries = listExplicitBuzzRoomIds(account.config.groups)
    .map((roomId) => {
      const id = parseBuzzTarget(roomId);
      return {
        kind: "group",
        id: buildBuzzTarget(id),
        name: id,
        raw: { roomId: id },
      } satisfies ChannelDirectoryEntry;
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));
  return applyBuzzDirectoryQueryAndLimit(entries, params);
}
