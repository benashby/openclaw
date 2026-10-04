import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listNativeCommandSpecsForConfig: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/native-command-registry", () => ({
  listNativeCommandSpecsForConfig: mocks.listNativeCommandSpecsForConfig,
}));

import { resolveBuzzCommandMenu } from "./command-menu.js";

function nativeCommand(
  name: string,
  options: Partial<Omit<NativeCommandSpec, "name">> = {},
): NativeCommandSpec {
  return {
    name,
    description: options.description ?? `Run ${name}`,
    acceptsArgs: options.acceptsArgs ?? false,
    ...options,
  };
}

function resolveNativeCommands(
  specs: NativeCommandSpec[],
  log?: NonNullable<Parameters<typeof resolveBuzzCommandMenu>[0]["log"]>,
) {
  mocks.listNativeCommandSpecsForConfig.mockReturnValue(specs);
  return resolveBuzzCommandMenu({ cfg: {}, log });
}

describe("Buzz command menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps native commands to ACP-shaped agent profile commands", () => {
    const warn = vi.fn();
    const longDescription = "\u{1F642}".repeat(101);
    const commands = resolveNativeCommands(
      [
        nativeCommand("Deploy-Now", {
          description: `  ${longDescription}  `,
          acceptsArgs: true,
          args: [
            { name: "target", description: "Target", type: "string", required: true },
            { name: "message", description: "Message", type: "string" },
          ],
        }),
        nativeCommand("deploy-now", { description: "Duplicate loses" }),
        nativeCommand("shortcut", { isAlias: true }),
        nativeCommand("bad name"),
        nativeCommand("also/bad"),
        nativeCommand("status", { description: "   ", acceptsArgs: true }),
        nativeCommand("noargs"),
        nativeCommand("long-hint", {
          args: Array.from({ length: 20 }, (_, index) => ({
            name: `argument${index}`,
            description: "Argument",
            type: "string" as const,
            required: index === 0,
          })),
        }),
      ],
      { warn },
    );

    expect(mocks.listNativeCommandSpecsForConfig).toHaveBeenCalledWith(
      {},
      { provider: "buzz", includeBundledChannelFallback: false },
    );
    expect(commands).toHaveLength(4);
    expect(commands[0]).toEqual({
      name: "deploy-now",
      description: expect.any(String),
      input: { hint: "<target> [message]" },
    });
    expect(Array.from(commands[0]?.description ?? "")).toHaveLength(100);
    expect(commands[1]).toEqual({
      name: "status",
      description: "status",
      input: { hint: "[args]" },
    });
    expect(commands[2]).toEqual({ name: "noargs", description: "Run noargs" });
    expect(Array.from(commands[3]?.input?.hint ?? "")).toHaveLength(100);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Buzz command menu skipped invalid native command names: "bad name", "also/bad"',
    );
  });

  it("keeps the first 100 unique normalized commands", () => {
    const specs = Array.from({ length: 101 }, (_, index) => nativeCommand(`command${index}`));

    const commands = resolveNativeCommands(specs);

    expect(commands).toHaveLength(100);
    expect(commands[0]?.name).toBe("command0");
    expect(commands[99]?.name).toBe("command99");
  });

  it("returns an empty list for an empty native catalog", () => {
    expect(resolveNativeCommands([])).toEqual([]);
  });
});
