import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { Outcome } from "@sovara/sdk";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { summaryOutput, text } from "./convert.ts";
import {
  connectionDetails,
  explainError,
  fromServerRequest,
  type ConnectionState,
} from "./diagnostics.ts";
import { Recorder } from "./recorder.ts";

const PARENT_ENV = "SOVARA_PI_PARENT";
const CONFIG_ENTRY = "sovara-config-v1";

/**
 * What a Pi parent passes to subagent processes through the environment. Every process Pi
 * starts inherits it, so the secret handle stays in an owner-only file that lives for the turn.
 */
interface Parent {
  url: string;
  projectName: string;
  handleFile: string;
}
function inheritedParent(): { url: string; projectName: string; handle: string } | undefined {
  const raw = process.env[PARENT_ENV];
  if (!raw) return;
  let value: Partial<Parent>;
  try {
    value = JSON.parse(raw) as Partial<Parent>;
  } catch {
    throw new ConfigError("Invalid Sovara parent context");
  }
  if (!value.url || !value.projectName)
    throw new ConfigError("Invalid Sovara parent context");
  if (typeof value.handleFile !== "string")
    throw new ConfigError(
      "The parent Pi session uses another @sovara/pi version; update it in both, then /reload",
    );
  let handle: string;
  try {
    handle = readFileSync(value.handleFile, "utf8").trim();
  } catch {
    throw new ConfigError("The parent Sovara turn has ended");
  }
  return { url: value.url, projectName: value.projectName, handle };
}

/** Write the handle to a new owner-only file; return a function that removes it. */
function writeHandleFile(handle: string): { path: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sovara-pi-"));
  const path = join(dir, "handle");
  writeFileSync(path, handle, { mode: 0o600 });
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

interface SummaryCapture {
  started: number;
  messages: AgentMessage[];
  signal?: AbortSignal;
}

export default function sovara(
  pi: ExtensionAPI,
  fetcher: typeof fetch = fetch,
): void {
  let recorder: Recorder | undefined;
  let selectedConfig: Config | undefined;
  let lastError: string | undefined;
  let connection: ConnectionState = "not contacted yet";
  let operationFailed = false;
  let lastRetrievalWarning: string | undefined;
  let summaryCapture: SummaryCapture | undefined;
  const originalParent = process.env[PARENT_ENV];
  let removeHandleFile: (() => void) | undefined;
  const restoreParent = () => {
    removeHandleFile?.();
    removeHandleFile = undefined;
    if (originalParent === undefined) delete process.env[PARENT_ENV];
    else process.env[PARENT_ENV] = originalParent;
  };
  const status = (ctx: ExtensionContext, text: string) => {
    if (ctx.hasUI) ctx.ui.setStatus("sovara", `sovara: ${text}`);
  };
  const report = (ctx: ExtensionContext, error: unknown) => {
    lastError = explainError(error, selectedConfig);
    if (fromServerRequest(error)) connection = "last request failed";
    if (!operationFailed) {
      if (ctx.hasUI) ctx.ui.notify(lastError, "warning");
      else console.error(`[sovara-pi] ${lastError}`);
    }
    operationFailed = true;
    status(ctx, "operation failed — /sovara for details");
  };
  const guarded = async (ctx: ExtensionContext, work: () => Promise<void>) => {
    const active = recorder;
    try {
      await work();
    } catch (error) {
      report(ctx, error);
    } finally {
      for (const current of new Set([active, recorder]))
        for (const error of current?.takeExportErrors() ?? [])
          report(ctx, error);
    }
  };
  async function cleanup(): Promise<void> {
    restoreParent();
    const previous = recorder;
    recorder = undefined;
    summaryCapture = undefined;
    await previous?.close("SessionClosed");
  }

  pi.registerCommand("sovara", {
    description: "Show Sovara project and recording status",
    handler: async (_args, ctx) => {
      const lines = selectedConfig
        ? connectionDetails(selectedConfig, connection)
        : ["Sovara configuration could not be loaded."];
      lines.push(
        `Recording: ${recorder ? (recorder.handle ? "active" : "idle") : "unavailable"}`,
      );
      if (recorder?.retrievalWarning)
        lines.push(`Lessons: ${recorder.retrievalWarning}`);
      if (lastError) lines.push(`Last error: ${lastError}`);
      ctx.ui.notify(lines.join("\n"), lastError ? "warning" : "info");
    },
  });

  pi.on("session_start", async (event, ctx) => {
    let initialized = false;
    await guarded(ctx, async () => {
      await cleanup();
      operationFailed = false;
      selectedConfig = undefined;
      lastError = undefined;
      connection = "not contacted yet";
      lastRetrievalWarning = undefined;
      const config = await loadConfig(
        ctx.cwd,
        undefined,
        undefined,
        ctx.isProjectTrusted(),
      );
      selectedConfig = config;
      const parent = inheritedParent();
      // A resumed session keeps its original project binding.
      const entries = ctx.sessionManager.getEntries();
      const saved = [...entries]
        .reverse()
        .find(
          (entry) =>
            entry.type === "custom" && entry.customType === CONFIG_ENTRY,
        );
      if (
        saved?.type === "custom" &&
        event.reason !== "fork" &&
        event.reason !== "new"
      ) {
        const data = saved.data as {
          projectName?: unknown;
        };
        if (typeof data?.projectName !== "string" || !data.projectName)
          throw new Error("Invalid session binding");
        config.projectName = data.projectName;
      }
      if (parent) {
        if (parent.url !== config.execUrl)
          throw new ConfigError("Subagent Sovara server differs from parent");
        config.projectName = parent.projectName;
      }
      // No network check here: the SDK discovers the server on the first recording, and a
      // prompt that cannot record is retried on the next one.
      const header = ctx.sessionManager.getHeader();
      recorder = new Recorder(
        config,
        ctx.sessionManager.getSessionId(),
        fetcher,
        parent?.handle,
        header?.parentSession,
      );
      if (!saved || event.reason === "fork" || event.reason === "new") {
        pi.appendEntry(CONFIG_ENTRY, {
          projectName: config.projectName,
        });
      }
      status(ctx, `${config.projectName} · configured`);
      initialized = true;
    });
    if (!initialized) await guarded(ctx, cleanup);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!recorder) return;
    summaryCapture = undefined;
    restoreParent();
    await guarded(ctx, async () => {
      operationFailed = false;
      lastError = undefined;
      const prompt =
        event.messageType === "user" ? event.prompt : event.message.content;
      await recorder!.start(text(prompt), ctx.signal);
      connection = "connected";
      const handleFile = writeHandleFile(recorder!.handle!);
      removeHandleFile = handleFile.remove;
      process.env[PARENT_ENV] = JSON.stringify({
        url: recorder!.config.execUrl,
        projectName: recorder!.config.projectName,
        handleFile: handleFile.path,
      } satisfies Parent);
      status(ctx, `${recorder!.config.projectName} · recording`);
    });
  });

  pi.on("context_with_system", async (event, ctx) => {
    const active = recorder;
    if (!active?.handle || summaryCapture) return;
    let messages = event.messages;
    await guarded(ctx, async () => {
      messages = await active.prepareGeneration(messages, ctx.model, ctx.signal);
    });
    const warning = active.retrievalWarning;
    if (warning && warning !== lastRetrievalWarning) {
      if (ctx.hasUI) ctx.ui.notify(`Sovara: ${warning}`, "warning");
      else console.error(`[sovara-pi] ${warning}`);
    }
    lastRetrievalWarning = warning;
    return { messages };
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    if (summaryCapture) return;
    await guarded(ctx, async () => {
      await recorder?.beginGeneration(ctx.signal);
    });
  });
  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role === "assistant")
      await guarded(ctx, async () => {
        await recorder?.endGeneration(message, ctx.signal);
      });
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    await guarded(ctx, async () => {
      await recorder?.beginTool(
        event.toolCallId,
        event.toolName,
        structuredClone(event.args),
        event.parentToolCallId,
        ctx.signal,
      );
    });
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    await guarded(ctx, async () => {
      await recorder?.endTool(
        event.toolCallId,
        structuredClone(event.result),
        event.isError,
        ctx.signal,
      );
    });
  });
  pi.on("agent_settled", async (_event, ctx) => {
    restoreParent();
    await guarded(ctx, async () => {
      await recorder?.close();
    });
    if (recorder)
      status(
        ctx,
        operationFailed
          ? "export incomplete"
          : recorder.retrievalWarning
            ? "turn export acknowledged · lesson retrieval warning"
            : "turn export acknowledged",
      );
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await guarded(ctx, cleanup);
  });

  async function summary(
    name: string,
    outcome: Outcome,
    ctx: ExtensionContext,
  ): Promise<void> {
    const captured = summaryCapture;
    summaryCapture = undefined;
    if (!recorder) return;
    const active = recorder;
    // An aborted summary is still recorded, within a short deadline.
    const signal = captured?.signal?.aborted
      ? AbortSignal.timeout(1000)
      : (captured?.signal ?? ctx.signal);
    await guarded(ctx, () =>
      active.summary(
        name,
        captured?.messages ?? [],
        outcome,
        ctx.model,
        captured ? (Date.now() - captured.started) / 1000 : 0,
        signal,
      ),
    );
  }
  const succeeded = (entry: { summary: string; usage?: Usage }): Outcome => ({
    status: "success",
    output: summaryOutput(entry.summary, entry.usage),
  });
  pi.on("session_before_compact", (event) => {
    summaryCapture = {
      started: Date.now(),
      messages: structuredClone([
        ...event.preparation.messagesToSummarize,
        ...event.preparation.turnPrefixMessages,
      ]),
      signal: event.signal,
    };
  });
  pi.on("session_before_tree", (event) => {
    summaryCapture = event.preparation.userWantsSummary
      ? {
          started: Date.now(),
          messages: structuredClone(
            event.preparation.entriesToSummarize.flatMap((entry) =>
              entry.type === "message" ? [entry.message] : [],
            ),
          ),
          signal: event.signal,
        }
      : undefined;
  });
  pi.on("session_compact_failed", async (event, ctx) => {
    await summary(
      "Compaction failed",
      event.aborted
        ? { status: "cancelled", reason: "Aborted" }
        : {
            status: "error",
            error: { type: "SummaryFailed", message: event.errorMessage ?? null },
          },
      ctx,
    );
  });
  pi.on("session_compact", async (event, ctx) => {
    await summary("Compaction", succeeded(event.compactionEntry), ctx);
  });
  pi.on("session_tree", async (event, ctx) => {
    if (event.summaryEntry)
      await summary("Branch summary", succeeded(event.summaryEntry), ctx);
    else summaryCapture = undefined;
  });
}
