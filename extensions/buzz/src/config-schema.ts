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
    threadSessions: z.boolean().optional(),
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
      .and(z.string().regex(/^[wW][sS][sS]?:\/\//, "Buzz relay URL must use ws:// or wss://"))
      .optional(),
    privateKey: buildSecretInputSchema().optional(),
    authTag: buildSecretInputSchema().optional(),
    groupPolicy: GroupPolicySchema.optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z
      .record(
        z.string().regex(BUZZ_CHANNEL_ID_PATTERN, "Buzz group key must be a channel UUID"),
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

const threadSessionsHint = {
  label: "Thread Sessions",
  help: "Give every Buzz thread its own session. A top-level message that reaches the bot starts a new thread session rooted at that message; replies in the thread continue it, and a bot that has taken part in a thread receives later replies there without a mention unless they mention only another bot. Off keeps one session per room.",
};

const roomThreadSessionsHint = {
  label: "Thread Sessions",
  help: "Override Thread Sessions for this room. False keeps one session for the whole room, so every message continues it and /new resets it; true gives each thread its own session. Omit to use the account setting.",
};

export const BuzzConfigSchema = buildChannelConfigSchema(RawBuzzConfigSchema, {
  uiHints: {
    threadSessions: threadSessionsHint,
    "accounts.*.threadSessions": threadSessionsHint,
    "groups.*.threadSessions": roomThreadSessionsHint,
    "accounts.*.groups.*.threadSessions": roomThreadSessionsHint,
  },
});
export type BuzzConfigInput = z.input<typeof RawBuzzConfigSchema>;
export type BuzzConfig = z.output<typeof RawBuzzConfigSchema>;
