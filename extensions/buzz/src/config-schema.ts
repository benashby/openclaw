import {
  buildChannelConfigSchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { BUZZ_CHANNEL_ID_PATTERN } from "./target.js";

const BuzzGroupConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    requireMentionInBotThreads: z.boolean().optional(),
    threadSessions: z.boolean().optional(),
    replyToMode: z.enum(["off", "all"]).optional(),
    groupPolicy: GroupPolicySchema.optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

export const BuzzAccountIdSchema = z
  .string()
  .regex(
    /^(?!(?:constructor|prototype)$)[a-z0-9][a-z0-9_-]{0,63}$/u,
    "Buzz account IDs must be canonical lowercase account keys",
  );

const BuzzAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    responsePrefix: z.string().optional(),
    replyToMode: z.enum(["off", "all"]).optional(),
    markdown: MarkdownConfigSchema,
    relayUrl: z
      .string()
      .url()
      .and(z.string().regex(/^[wW][sS][sS]?:\/\/.+/, "Buzz relay URL must use ws:// or wss://"))
      .optional(),
    privateKey: buildSecretInputSchema().optional(),
    authTag: buildSecretInputSchema().optional(),
    groupPolicy: GroupPolicySchema.optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z
      .record(
        z
          .string()
          .regex(
            new RegExp(`^(?:\\*|${BUZZ_CHANNEL_ID_PATTERN.source.slice(1, -1)})$`, "u"),
            'Buzz group key must be a channel UUID or "*"',
          ),
        BuzzGroupConfigSchema,
      )
      .optional(),
    historyLimit: z.number().int().min(0).max(20).optional(),
    threadSessions: z.boolean().optional(),
    defaultTo: z.string().optional(),
  })
  .strict();

const RawBuzzConfigSchema = BuzzAccountConfigSchema.extend({
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  accounts: z.record(BuzzAccountIdSchema, BuzzAccountConfigSchema).optional(),
  defaultAccount: BuzzAccountIdSchema.optional(),
});

const botThreadMentionHint = {
  label: "Require Mention in Bot Threads",
  help: "Override mention gating in threads whose root message was signed by this bot in the same room. False allows unmentioned replies; true requires a mention. Omit to preserve the room's mention policy. Sender restrictions still apply.",
};

const threadSessionsHint = {
  label: "Thread Sessions",
  help: "Give every Buzz thread its own session. A top-level message that reaches the bot starts a new thread session rooted at that message; replies in the thread continue it, and a bot that has taken part in a thread receives later replies there without a mention unless they mention only another bot. Off keeps one session per room.",
};

const roomReplyToModeHint = {
  label: "Reply To Mode",
  help: "Override Reply To Mode for this room. Off posts the bot's replies and typing indicator in the room itself instead of a thread under the triggering message; all threads them. Omit to use the account setting.",
};

const roomsHint = {
  label: "Rooms",
  help: 'Rooms this identity answers in, keyed by room UUID. A "*" entry applies to every room where the bot holds the Bot role, so the bot joins them automatically, including rooms it is added to later. A room\'s own entry overrides "*" field by field, and enabled=false on a room keeps the bot out of it.',
};

const roomThreadSessionsHint = {
  label: "Thread Sessions",
  help: "Override Thread Sessions for this room. False keeps one session for the whole room, so every message continues it and /new resets it; true gives each thread its own session. Omit to use the account setting.",
};

export const BuzzConfigSchema = buildChannelConfigSchema(RawBuzzConfigSchema, {
  uiHints: {
    "groups.*.requireMentionInBotThreads": botThreadMentionHint,
    "accounts.*.groups.*.requireMentionInBotThreads": botThreadMentionHint,
    threadSessions: threadSessionsHint,
    "accounts.*.threadSessions": threadSessionsHint,
    "groups.*.threadSessions": roomThreadSessionsHint,
    "accounts.*.groups.*.threadSessions": roomThreadSessionsHint,
    "groups.*.replyToMode": roomReplyToModeHint,
    groups: roomsHint,
    "accounts.*.groups": roomsHint,
    "accounts.*.groups.*.replyToMode": roomReplyToModeHint,
  },
});
export type BuzzConfigInput = z.input<typeof RawBuzzConfigSchema>;
export type BuzzConfig = z.output<typeof RawBuzzConfigSchema>;
