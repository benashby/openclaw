import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  listNativeCommandSpecsForConfig,
  type NativeCommandSpec,
} from "openclaw/plugin-sdk/native-command-registry";
import { truncateCodePoints } from "openclaw/plugin-sdk/text-utility-runtime";

const BUZZ_COMMAND_PATTERN = /^[a-z0-9_-]{1,32}$/u;
const BUZZ_MAX_COMMANDS = 100;
const BUZZ_MAX_DESCRIPTION_LENGTH = 100;
const BUZZ_MAX_INPUT_HINT_LENGTH = 100;

// Same shape as ACP available_commands_update entries, so Buzz clients can read
// bot and ACP command lists alike.
export type BuzzAgentCommand = {
  name: string;
  description: string;
  input?: { hint: string };
};

type BuzzCommandMenuLogger = {
  warn?: (message: string) => void;
};

function commandInputHint(spec: NativeCommandSpec): string | undefined {
  if (spec.args?.length) {
    return truncateCodePoints(
      spec.args.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(" "),
      BUZZ_MAX_INPUT_HINT_LENGTH,
    );
  }
  return spec.acceptsArgs ? "[args]" : undefined;
}

function mapNativeCommandSpecsToBuzzCommands(
  specs: NativeCommandSpec[],
  log?: BuzzCommandMenuLogger,
): BuzzAgentCommand[] {
  const commands: BuzzAgentCommand[] = [];
  const seen = new Set<string>();
  const invalidNames = new Set<string>();

  for (const spec of specs) {
    if (spec.isAlias) {
      continue;
    }
    const name = spec.name.trim().toLowerCase();
    if (!BUZZ_COMMAND_PATTERN.test(name)) {
      invalidNames.add(spec.name.trim() || "<empty>");
      continue;
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);

    const hint = commandInputHint(spec);
    commands.push({
      name,
      description: truncateCodePoints(spec.description.trim() || name, BUZZ_MAX_DESCRIPTION_LENGTH),
      ...(hint ? { input: { hint } } : {}),
    });
  }

  if (invalidNames.size > 0) {
    log?.warn?.(
      `Buzz command menu skipped invalid native command names: ${[...invalidNames]
        .map((name) => JSON.stringify(name))
        .join(", ")}`,
    );
  }

  return commands.slice(0, BUZZ_MAX_COMMANDS);
}

export function resolveBuzzCommandMenu(params: {
  cfg: OpenClawConfig;
  log?: BuzzCommandMenuLogger;
}): BuzzAgentCommand[] {
  // Native specs only, as ClickClack publishes. Skill, plugin, and custom command
  // catalogs can follow once Buzz clients define how to show them. The Buzz plugin
  // is already loaded here; the bundled fallback would import it again from disk.
  const specs = listNativeCommandSpecsForConfig(params.cfg, {
    provider: "buzz",
    includeBundledChannelFallback: false,
  });
  return mapNativeCommandSpecsToBuzzCommands(specs, params.log);
}
