/** Runs a CLI backend's own context report against a session's resumable native transcript. */
import type { CliSessionBinding, SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isAbortError } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { resolveCliBackendConfig } from "./cli-backends.js";

const NATIVE_CONTEXT_REPORT_TIMEOUT_MS = 60_000;

export type NativeCliContextReport = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Returns undefined when the runtime has no native report or no resumable session,
 * so callers fall back to OpenClaw's own context report.
 */
export async function reportNativeCliContext(params: {
  runtime: string | undefined;
  config: OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  workspaceDir: string;
  agentDir?: string;
  provider: string;
  model: string;
  cliSessionId?: string;
  cliSessionBinding?: CliSessionBinding;
  authProfileId?: string;
  sessionEntry?: SessionEntry;
  abortSignal?: AbortSignal;
}): Promise<NativeCliContextReport | undefined> {
  const runtime = normalizeOptionalAgentRuntimeId(params.runtime);
  if (!runtime) {
    return undefined;
  }
  const nativeContextReport = resolveCliBackendConfig(runtime, params.config, {
    agentId: params.agentId,
  })?.nativeContextReport;
  const cliSessionId = (params.cliSessionBinding?.sessionId ?? params.cliSessionId)?.trim();
  if (!nativeContextReport || !cliSessionId) {
    return undefined;
  }
  const { runCliAgent } = await import("./cli-runner.js");
  const runId = `${params.sessionId}:native-context`;
  const sessionAgentId = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  }).sessionAgentId;
  const preparedRunAdmission = prepareSystemAgentRunAdmission(
    params.config,
    runId,
    sessionAgentId,
    "agents.native-context",
  );
  try {
    const result = await runCliAgent({
      preparedRunAdmission,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionKey,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      config: params.config,
      prompt: nativeContextReport.buildPrompt(),
      provider: runtime,
      modelProvider: params.provider,
      model: params.model,
      timeoutMs: NATIVE_CONTEXT_REPORT_TIMEOUT_MS,
      runId,
      cliSessionId,
      ...(params.cliSessionBinding ? { cliSessionBinding: params.cliSessionBinding } : {}),
      ...((params.cliSessionBinding?.authProfileId ?? params.authProfileId)
        ? { authProfileId: params.cliSessionBinding?.authProfileId ?? params.authProfileId }
        : {}),
      ...(params.sessionEntry ? { sessionEntry: params.sessionEntry } : {}),
      contextWindow: params.sessionEntry?.contextWindow,
      trigger: "manual",
      controlOperation: "context",
      // The report reads the session without rewriting it, so an idle live session
      // stays valid and is left running, unlike after native compaction.
      disableCliLiveSession: true,
      abortSignal: params.abortSignal,
    });
    const text = result.payloads?.find((payload) => payload.text?.trim())?.text?.trim();
    return text
      ? { ok: true, text }
      : { ok: false, reason: `CLI backend "${runtime}" returned an empty context report.` };
  } catch (err) {
    if (params.abortSignal?.aborted && (isAbortError(err) || err === params.abortSignal.reason)) {
      throw err;
    }
    return {
      ok: false,
      reason: `CLI backend "${runtime}" failed to report its native context: ${formatErrorMessage(err)}`,
    };
  } finally {
    preparedRunAdmission.close();
  }
}
