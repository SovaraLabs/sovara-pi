import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  closeRecording,
  exportRecording,
  getTraceId,
  openRecording,
  recordStep,
  resumeRecording,
  SovaraClient,
  startStep,
  startTurn,
  type Call,
  type Execution,
  type JsonObject,
  type JsonValue,
  type Outcome,
  type Step,
} from "@sovara/sdk";
import type { Config } from "./config.ts";
import { bounded } from "./connection.ts";
import { conversation, output, text } from "./convert.ts";
import { cleanMessages, referenceMessage } from "./lessons.ts";

export interface Model {
  id: string;
  provider: string;
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

/** Pi names MCP tools `mcp__<server>__<tool>`. */
export function toolCall(
  id: string,
  name: string,
  args: unknown,
  parentToolCallId?: string,
): Call {
  const metadata: JsonObject | undefined = parentToolCallId
    ? { parent_tool_call_id: parentToolCallId }
    : undefined;
  const common = {
    call_id: id,
    arguments: json(args),
    ...(metadata ? { metadata } : {}),
  };
  const [prefix, server, ...rest] = name.split("__");
  if (prefix === "mcp" && server && rest.length)
    return { kind: "mcp", name: rest.join("__"), server, ...common };
  return { kind: "tool", name, ...common };
}

/**
 * One Sovara recording per Pi agent run, on the session's trace (or, for a subagent, on a
 * child trace of the parent's turn). Holds only the recording handle between events.
 */
export class Recorder {
  /** Handle of the active recording and its turn; a secret, never shown or logged. */
  handle?: string;
  retrievalWarning?: string;
  /** The model step of the current attempt; `sent` once its provider request went out. */
  private generation?: { step: Step; execution?: Execution; sent: boolean };
  /** The latest prepared model call and the input sent for it, for provider retries. */
  private prepared?: { call: Call; input: AgentMessage[]; lessons: boolean };
  private readonly tools = new Map<string, Step>();
  private readonly exportErrors: unknown[] = [];
  private turnInput: string | null = null;
  private finalOutput = "";
  private turnSignal?: AbortSignal;

  constructor(
    readonly config: Config,
    readonly sessionId: string,
    readonly fetch: typeof globalThis.fetch,
    readonly parent?: string,
    readonly parentSession?: string,
  ) {}

  private resume<T>(fn: () => Promise<T>): Promise<T> {
    return resumeRecording(this.handle!, fn, { fetch: this.fetch });
  }

  takeExportErrors(): unknown[] {
    return this.exportErrors.splice(0);
  }

  private async attemptExport<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (error) {
      this.exportErrors.push(error);
      return undefined;
    }
  }

  /**
   * Open a recording and start its turn. `traceInput` becomes the trace's latest input when
   * the recording closes; null leaves the trace's input and output unchanged.
   */
  async start(input: string, signal?: AbortSignal, traceInput: string | null = input): Promise<void> {
    if (this.handle) await this.close("Superseded");
    signal?.throwIfAborted();
    this.turnSignal = signal;
    this.turnInput = traceInput;
    this.finalOutput = "";
    this.prepared = undefined;
    const opening = this.parent
      ? openRecording({
          parent: this.parent,
          name: `Pi subagent ${this.sessionId}`,
          fetch: this.fetch,
        })
      : openRecording({
          projectName: this.config.projectName,
          name: "Pi session",
          traceId: `pi:${this.sessionId}`,
          url: this.config.execUrl,
          agentToken: this.config.agentToken,
          fetch: this.fetch,
        });
    // Kept before the turn starts, so shutdown can close it if that fails.
    this.handle = await bounded(opening, signal);
    this.handle = await bounded(
      this.resume(async () => {
        await startTurn(input);
        return exportRecording()!;
      }),
      signal,
    );
  }

  /**
   * Start the model step for the next generation, with the lessons the server selects for
   * this conversation, and return the messages to send. Any step still pending from an
   * earlier context is cancelled first.
   */
  async prepareGeneration(
    messages: AgentMessage[],
    model: Model | undefined,
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    this.turnSignal = signal ?? this.turnSignal;
    signal?.throwIfAborted();
    if (!this.handle) return messages;
    await this.cancelGeneration("Superseded", signal);
    const call: Call = {
      kind: "llm",
      provider: model?.provider ?? null,
      model: model?.id ?? null,
      input: conversation(cleanMessages(messages)),
      metadata: {
        pi_session_id: this.sessionId,
        ...(this.parentSession ? { parent_session: this.parentSession } : {}),
      },
    };
    this.prepared = { call, input: messages, lessons: false };
    let step: Step;
    try {
      step = await bounded(this.resume(() => startStep(call, { lessons: true })), signal);
    } catch (error) {
      this.retrievalWarning = "Lesson retrieval failed.";
      throw error;
    }
    this.retrievalWarning = undefined;
    const lessons = step.lessonContext;
    if (!lessons?.text) {
      this.generation = { step, sent: false };
      return messages;
    }
    const sent = [...messages, referenceMessage(lessons.text)];
    this.prepared = { call, input: structuredClone(sent), lessons: true };
    this.generation = {
      step,
      execution: { input: conversation(sent), injected_retrieval_id: lessons.retrieval_id },
      sent: false,
    };
    return sent;
  }

  /**
   * Mark the prepared step as sent. A provider retry, or a request with no new context,
   * gets a step of its own, so each attempt keeps its own outcome.
   */
  async beginGeneration(signal?: AbortSignal): Promise<void> {
    this.turnSignal = signal ?? this.turnSignal;
    signal?.throwIfAborted();
    if (!this.handle) return;
    if (this.generation && !this.generation.sent) {
      this.generation.sent = true;
      return;
    }
    await this.cancelGeneration("ProviderRetry", signal);
    signal?.throwIfAborted();
    const prepared = this.prepared;
    if (!prepared) return;
    const step = await bounded(this.resume(() => startStep(prepared.call)), signal);
    // The retry resends the same input; its lessons belong to the first attempt's retrieval.
    const execution = prepared.lessons ? { input: conversation(prepared.input) } : undefined;
    this.generation = { step, execution, sent: true };
  }

  private async cancelGeneration(reason: string, signal?: AbortSignal): Promise<void> {
    const previous = this.generation;
    if (!previous) return;
    this.generation = undefined;
    // An attempt that was sent reports the input it carried.
    const options = previous.sent && previous.execution ? { execution: previous.execution } : undefined;
    await this.attemptExport(() => bounded(previous.step.cancel(reason, options), signal));
  }

  async endGeneration(message: AssistantMessage, signal?: AbortSignal): Promise<void> {
    this.finalOutput = text(message.content);
    const current = this.generation;
    if (!current) return;
    this.generation = undefined;
    this.turnSignal = signal ?? this.turnSignal;
    const sent = current.execution ? { execution: current.execution } : {};
    const options = { output: output(message), ...sent };
    const ending =
      message.stopReason === "error"
        ? current.step.fail(
            { type: "ProviderError", message: message.errorMessage ?? null },
            options,
          )
        : message.stopReason === "aborted"
          ? current.step.cancel("Aborted", options)
          : current.step.finish(options.output, sent);
    await bounded(ending, signal);
  }

  async beginTool(
    id: string,
    name: string,
    args: unknown,
    parentToolCallId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.turnSignal = signal ?? this.turnSignal;
    signal?.throwIfAborted();
    if (!this.handle) return;
    const call = toolCall(id, name, args, parentToolCallId);
    this.tools.set(id, await bounded(this.resume(() => startStep(call)), signal));
  }

  async endTool(
    id: string,
    result: unknown,
    failed: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    this.turnSignal = signal ?? this.turnSignal;
    const step = this.tools.get(id);
    if (!step) return;
    this.tools.delete(id);
    const content = (result as { content?: unknown } | null)?.content;
    const ending = failed
      ? step.fail(
          {
            type: "ToolError",
            message: Array.isArray(content) ? text(content) : null,
          },
          { output: json(result) },
        )
      : step.finish(json(result));
    await bounded(ending, signal);
  }

  /**
   * Record a compaction or branch summary, in the active turn or in a short recording of
   * its own that leaves the trace's latest input and output unchanged.
   */
  async summary(
    kind: string,
    messages: AgentMessage[],
    outcome: Outcome,
    model: Model | undefined,
    latencySeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const ownsTurn = !this.handle;
    try {
      if (ownsTurn) await this.start(kind, signal, null);
      const call: Call = {
        kind: "llm",
        provider: model?.provider ?? null,
        model: model?.id ?? null,
        input: conversation(messages),
        metadata: { summary_kind: kind },
      };
      await bounded(
        this.resume(() => recordStep(call, outcome, { latencySeconds })),
        signal,
      );
    } finally {
      if (ownsTurn) await this.close();
    }
  }

  /** End pending steps, write the trace's latest input and output, and close the recording. */
  async close(reason = "Interrupted"): Promise<void> {
    const handle = this.handle;
    if (!handle) return;
    this.handle = undefined;
    const pending = [
      ...this.tools.values(),
      ...(this.generation ? [this.generation.step] : []),
    ];
    this.tools.clear();
    this.generation = undefined;
    this.prepared = undefined;
    const signal = this.turnSignal;
    this.turnSignal = undefined;
    const traceInput = this.turnInput;
    const traceOutput = this.finalOutput;
    const work = async () => {
      await Promise.all(
        pending.map((step) => this.attemptExport(() => step.cancel(reason))),
      );
      if (traceInput !== null) {
        const client = new SovaraClient({
          projectName: this.config.projectName,
          url: this.config.execUrl,
          agentToken: this.config.agentToken,
          fetch: this.fetch,
        });
        await this.attemptExport(() =>
          resumeRecording(
            handle,
            () => client.log({ traceId: getTraceId()!, traceInput, traceOutput }),
            { fetch: this.fetch },
          ),
        );
      }
      await this.attemptExport(() => closeRecording(handle, { fetch: this.fetch }));
    };
    // One budget for the whole close, shortened to one second on cancellation.
    await this.attemptExport(() => bounded(work(), signal));
  }
}
