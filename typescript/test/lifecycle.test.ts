import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import extension from "../src/index.ts";
import { fixtureServer } from "./helpers.ts";

const usage = {
  input: 12,
  output: 7,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 22,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function answer(stopReason = "stop", extra: Record<string, unknown> = {}) {
  return {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      usage,
      stopReason,
      ...extra,
    },
  };
}

function handle(origin: string): string {
  const payload = {
    lesson_scope: null,
    origin,
    project_id: "parent-project-id",
    project_name: "parent-project",
    recording_id: "parent-recording",
    runner_api: 6,
    token: "parent-secret",
    trace_id: "parent-trace",
    turn_id: "parent-turn",
  };
  return `sovara-recording-1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

async function harness(parent?: (url: string) => string) {
  const backend = await fixtureServer();
  const cwd = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
  await mkdir(join(cwd, ".pi"));
  const previous = {
    SOVARA_SERVER_URL: process.env.SOVARA_SERVER_URL,
    SOVARA_AGENT_TOKEN: process.env.SOVARA_AGENT_TOKEN,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    SOVARA_PI_PARENT: process.env.SOVARA_PI_PARENT,
  };
  process.env.SOVARA_SERVER_URL = backend.config.execUrl;
  process.env.SOVARA_AGENT_TOKEN = "agent-secret";
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  if (parent) process.env.SOVARA_PI_PARENT = parent(backend.config.execUrl);
  else delete process.env.SOVARA_PI_PARENT;
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let entries: any[] = [];
  let sessionId = "session-1";
  const statuses: string[] = [];
  const notifications: string[] = [];
  const commands = new Map<string, any>();
  const api = {
    on(name: string, callback: any) {
      handlers.set(name, callback);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    signal: undefined as AbortSignal | undefined,
    model: { id: "test-model", provider: "test-provider" },
    ui: {
      setStatus: (_key: string, value: string) => statuses.push(value),
      notify(message: string) {
        notifications.push(message);
      },
    },
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => sessionId,
      getHeader: () => ({}),
    },
  };
  extension(api);
  const emit = (name: string, event: Record<string, unknown> = {}) =>
    handlers.get(name)?.({ type: name, ...event }, ctx);
  return {
    backend,
    statuses,
    notifications,
    command: (name: string) => commands.get(name).handler("", ctx),
    emit,
    ctx,
    async config(projectName: string) {
      await writeFile(
        join(cwd, ".pi", "sovara.json"),
        JSON.stringify({ projectName }),
      );
    },
    newSession() {
      entries = [];
      sessionId = "session-2";
    },
    async start() {
      await emit("session_start", { reason: "startup" });
    },
    async prompt(prompt = "task") {
      await emit("before_agent_start", {
        messageType: "user",
        prompt,
        systemPromptOptions: { sections: {} },
      });
    },
    async close() {
      await emit("session_shutdown", { reason: "quit" });
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await backend.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test("project changes apply to new sessions while resume keeps its binding", async () => {
  const h = await harness();
  try {
    await h.config("original");
    await h.start();
    await h.config("changed");
    await h.emit("session_shutdown", { reason: "reload" });
    await h.emit("session_start", { reason: "resume" });
    assert.match(h.statuses.at(-1)!, /original/);
    await h.emit("session_shutdown", { reason: "new" });
    h.newSession();
    await h.emit("session_start", { reason: "new" });
    assert.match(h.statuses.at(-1)!, /changed/);
  } finally {
    await h.close();
  }
});

test("a turn records the model call, its lessons, a tool, and the trace's latest input and output", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.prompt("Fix the build");
    const open = h.backend.to("/exec/traces")[0]!;
    assert.equal(open.body.trace_id, "pi:session-1");
    assert.equal(open.body.name, "Pi session");
    assert.equal(open.headers["x-sovara-agent-token"], "agent-secret");
    assert.equal(h.backend.to("/turns")[0]!.body.turn_input, "Fix the build");

    const messages = [{ role: "user", content: "Fix the build", timestamp: 1 }];
    const result = await h.emit("context_with_system", { messages });
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[1].customType, "sovara-lessons");
    assert.equal(result.messages[1].content, "Use a deterministic clock.");
    assert.equal(messages.length, 1);
    await h.emit("before_provider_request", { payload: {} });
    await h.emit("message_end", answer());
    await h.emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "a" } });
    await h.emit("tool_execution_end", {
      toolCallId: "t1",
      result: { content: [{ type: "text", text: "contents" }] },
      isError: false,
    });
    await h.emit("agent_settled");

    const [llm, tool] = h.backend.to("/steps");
    assert.deepEqual(llm!.body.call, {
      kind: "llm",
      provider: "test-provider",
      model: "test-model",
      input: {
        format: "conversation",
        messages: [{ role: "user", content: [{ type: "text", text: "Fix the build" }] }],
      },
      metadata: { pi_session_id: "session-1" },
    });
    assert.deepEqual(tool!.body.call, {
      kind: "tool",
      name: "read",
      call_id: "t1",
      arguments: { path: "a" },
    });
    const [llmEnd, toolEnd] = h.backend.to("/finalize");
    assert.deepEqual(llmEnd!.body.outcome, {
      status: "success",
      output: {
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
        stop_reason: "stop",
        usage: { input_tokens: 12, output_tokens: 7, cache_read_tokens: 2, cache_write_tokens: 1 },
      },
    });
    assert.equal(llmEnd!.body.execution.injected_retrieval_id, "retrieval-1");
    assert.match(JSON.stringify(llmEnd!.body.execution.input), /Use a deterministic clock/);
    assert.equal(toolEnd!.body.outcome.status, "success");
    assert.deepEqual(h.backend.to("/exec/log-fields")[0]!.body.payload, {
      trace_id: "trace-1",
      trace_input: "Fix the build",
      trace_output: "answer",
    });
    assert.equal(h.backend.calls.at(-1)!.path, "/exec/traces/trace-1/complete");
    assert.equal(h.statuses.at(-1), "sovara: turn export acknowledged");
  } finally {
    await h.close();
  }
});

test("model calls without lessons, retries, failures and aborts end their steps", async () => {
  const h = await harness();
  try {
    h.backend.lessons(null);
    await h.start();
    await h.prompt();
    const messages = [{ role: "user", content: "task", timestamp: 1 }];
    assert.deepEqual((await h.emit("context_with_system", { messages })).messages, messages);
    await h.emit("before_provider_request", { payload: {} });
    await h.emit("before_provider_request", { payload: {} });
    await h.emit("message_end", answer("error", { errorMessage: "overloaded" }));
    await h.emit("before_provider_request", { payload: {} });
    await h.emit("message_end", answer("aborted"));
    await h.emit("agent_settled");

    const outcomes = h.backend.to("/finalize").map((call) => call.body);
    assert.deepEqual(outcomes.map((body) => body.outcome.status), ["cancelled", "error", "cancelled"]);
    assert.equal(outcomes[0]!.outcome.reason, "ProviderRetry");
    assert.deepEqual(outcomes[1]!.outcome.error, { type: "ProviderError", message: "overloaded" });
    assert.equal(outcomes[2]!.outcome.reason, "Aborted");
    assert.ok(outcomes.every((body) => body.execution === null));
  } finally {
    await h.close();
  }
});

test("each provider attempt is its own step; only the first carries the retrieval", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.prompt();
    const messages = [{ role: "user", content: "task", timestamp: 1 }];
    // A context replaced before it was sent cancels its step.
    await h.emit("context_with_system", { messages });
    const result = await h.emit("context_with_system", { messages });
    assert.match(JSON.stringify(result.messages), /Use a deterministic clock/);
    await h.emit("before_provider_request", { payload: {} });
    await h.emit("before_provider_request", { payload: {} });
    await h.emit("message_end", answer());
    await h.emit("agent_settled");

    const prepares = h.backend.to("/steps").map((call) => call.body);
    assert.deepEqual(prepares.map((body) => body.lessons === true), [true, true, false]);
    assert.ok(prepares.every((body) => !JSON.stringify(body.call).includes("deterministic clock")));
    const [superseded, retried, answered] = h.backend.to("/finalize").map((call) => call.body);
    assert.deepEqual(superseded!.outcome, { status: "cancelled", reason: "Superseded" });
    assert.equal(superseded!.execution, null);
    assert.equal(retried!.outcome.reason, "ProviderRetry");
    assert.equal(retried!.execution.injected_retrieval_id, "retrieval-1");
    assert.equal(answered!.outcome.status, "success");
    assert.equal(answered!.execution.injected_retrieval_id, undefined);
    assert.match(JSON.stringify(answered!.execution.input), /Use a deterministic clock/);
  } finally {
    await h.close();
  }
});

test("MCP tools and failed tools are recorded by kind and outcome", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.prompt();
    await h.emit("tool_execution_start", {
      toolCallId: "m1",
      toolName: "mcp__github__search_issues",
      args: { q: "bug" },
      parentToolCallId: "outer",
    });
    await h.emit("tool_execution_end", {
      toolCallId: "m1",
      result: { content: [{ type: "text", text: "rate limited" }] },
      isError: true,
    });
    await h.emit("tool_execution_start", { toolCallId: "t2", toolName: "bash", args: {} });
    await h.emit("agent_settled");

    const [mcp] = h.backend.to("/steps");
    assert.deepEqual(mcp!.body.call, {
      kind: "mcp",
      name: "search_issues",
      server: "github",
      call_id: "m1",
      arguments: { q: "bug" },
      metadata: { parent_tool_call_id: "outer" },
    });
    const [failed, interrupted] = h.backend.to("/finalize").map((call) => call.body.outcome);
    assert.deepEqual(failed!.error, { type: "ToolError", message: "rate limited" });
    assert.deepEqual(interrupted, { status: "cancelled", reason: "Interrupted" });
  } finally {
    await h.close();
  }
});

test("subagent processes open a child trace under the parent turn and restore the parent", async () => {
  const parentDir = await mkdtemp(join(tmpdir(), "pi-parent-"));
  const parentFile = join(parentDir, "handle");
  const h = await harness((url) => {
    writeFileSync(parentFile, handle(url));
    return JSON.stringify({ url, projectName: "parent-project", handleFile: parentFile });
  });
  const parentValue = process.env.SOVARA_PI_PARENT;
  try {
    await h.config("workspace");
    await h.start();
    assert.match(h.statuses.at(-1)!, /parent-project/);
    await h.prompt();
    const subtrace = h.backend.to("/subtraces")[0]!;
    assert.equal(subtrace.path, "/exec/traces/parent-trace/subtraces");
    assert.equal(subtrace.body.turn_id, "parent-turn");
    assert.equal(subtrace.body.name, "Pi subagent session-1");
    assert.equal(subtrace.headers["x-sovara-trace-token"], "parent-secret");
    const child = JSON.parse(process.env.SOVARA_PI_PARENT!);
    assert.equal(child.projectName, "parent-project");
    assert.equal(child.handle, undefined);
    assert.doesNotMatch(process.env.SOVARA_PI_PARENT!, /sovara-recording-1|secret/);
    assert.equal(statSync(child.handleFile).mode & 0o777, 0o600);
    assert.match(readFileSync(child.handleFile, "utf8"), /^sovara-recording-1\./);
    await h.emit("agent_settled");
    assert.equal(existsSync(child.handleFile), false);
    assert.equal(process.env.SOVARA_PI_PARENT, parentValue);
    assert.equal(h.backend.to("/exec/traces").length, 0);
    assert.equal(h.backend.to("/exec/log-fields")[0]!.body.payload.trace_id, "trace-1");
  } finally {
    await h.close();
    await rm(parentDir, { recursive: true, force: true });
  }
});

test("a parent from an older extension asks to update both", async () => {
  const h = await harness((url) =>
    JSON.stringify({ url, projectName: "p", scope: { recording: {}, turnId: "t" } }),
  );
  try {
    await h.start();
    assert.match(h.notifications.at(-1)!, /update it in both/);
    await h.prompt();
    assert.equal(h.backend.to("/subtraces").length, 0);
  } finally {
    await h.close();
  }
});

test("retrieval failure leaves context intact; export failure never reports success", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.prompt();
    h.backend.reject(/\/steps$/);
    const messages = [{ role: "user", content: "task", timestamp: 1 }];
    const result = await h.emit("context_with_system", { messages });
    assert.deepEqual(result.messages, messages);
    assert.match(h.notifications.join("\n"), /Lesson retrieval failed/);
    assert.doesNotMatch(h.notifications.join("\n"), /PRIVATE/);
    h.backend.reject(/finalize$/);
    await h.emit("before_provider_request", { payload: {} });
    await h.emit("message_end", answer());
    h.backend.reject();
    await h.emit("agent_settled");
    assert.equal(h.statuses.at(-1), "sovara: export incomplete");
    await h.command("sovara");
    assert.doesNotMatch(h.notifications.at(-1)!, /PRIVATE|secret/);
  } finally {
    await h.close();
  }
});

test("compaction records one summary step from the summarized messages", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.prompt();
    await h.emit("session_before_compact", {
      preparation: {
        messagesToSummarize: [{ role: "user", content: "old work", timestamp: 1 }],
        turnPrefixMessages: [],
      },
    });
    await h.emit("before_provider_request", { payload: { messages: ["summary input"] } });
    await h.emit("session_compact", { compactionEntry: { summary: "summary", usage } });
    await h.emit("agent_settled");

    assert.equal(h.backend.to("/steps").length, 0);
    const [summary] = h.backend.to("/steps/record");
    assert.deepEqual(summary!.body.call.input.messages, [
      { role: "user", content: [{ type: "text", text: "old work" }] },
    ]);
    assert.deepEqual(summary!.body.call.metadata, { summary_kind: "Compaction" });
    assert.equal(summary!.body.outcome.output.message.content[0].text, "summary");
    assert.equal(summary!.body.turn_id, "turn-1");
  } finally {
    await h.close();
  }
});

test("a standalone failed summary closes its own recording without touching trace output", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.emit("session_before_compact", {
      preparation: { messagesToSummarize: [], turnPrefixMessages: [] },
      signal: AbortSignal.abort(),
    });
    await h.emit("session_compact_failed", { aborted: false, errorMessage: "too long" });
    const [summary] = h.backend.to("/steps/record");
    assert.deepEqual(summary!.body.outcome.error, { type: "SummaryFailed", message: "too long" });
    assert.equal(h.backend.to("/turns")[0]!.body.turn_input, "Compaction failed");
    assert.equal(h.backend.calls.at(-1)!.path, "/exec/traces/trace-1/complete");
    assert.equal(h.backend.to("/exec/log-fields").length, 0);
    await h.prompt();
    const result = await h.emit("context_with_system", {
      messages: [{ role: "user", content: "task", timestamp: 1 }],
    });
    assert.match(JSON.stringify(result.messages), /Use a deterministic clock/);
  } finally {
    await h.close();
  }
});

for (const event of ["context_with_system", "tool_execution_start"]) {
  test(`Pi cancellation stops waiting on ${event}`, { timeout: 5000 }, async () => {
    const h = await harness();
    try {
      const controller = new AbortController();
      h.ctx.signal = controller.signal;
      await h.start();
      await h.prompt();
      const reached = h.backend.blockNext(/\/steps$/);
      const messages = [{ role: "user", content: "task", timestamp: 1 }];
      const running = h.emit(event, { messages, toolCallId: "a", toolName: "read", args: {} });
      await reached;
      const aborted = Date.now();
      controller.abort();
      await running;
      assert.ok(Date.now() - aborted < 2000);
      const before = h.backend.calls.length;
      await h.emit(event, { messages, toolCallId: "b", toolName: "read", args: {} });
      assert.equal(h.backend.calls.length, before, "already cancelled hooks must send no requests");
    } finally {
      h.ctx.signal = undefined;
      await h.close();
    }
  });
}

test("sovara command explains an incompatible server without secrets", async () => {
  const h = await harness();
  try {
    h.backend.versions([5]);
    await h.start();
    await h.command("sovara");
    assert.match(h.notifications.at(-1)!, /Connection: not contacted yet/);
    await h.prompt();
    await h.command("sovara");
    const text = h.notifications.at(-1)!;
    assert.match(text, new RegExp(h.backend.config.execUrl));
    assert.match(text, /Mode: explicit URL override/);
    assert.match(text, /Connection: last request failed/);
    assert.match(text, /compatible Sovara\/Pi extension versions/);
    assert.doesNotMatch(text, /agent-secret|recording-secret/);
    h.backend.versions([6]);
    await h.emit("session_start", { reason: "reload" });
    await h.prompt();
    await h.command("sovara");
    assert.match(h.notifications.at(-1)!, /Connection: connected/);
    assert.doesNotMatch(h.notifications.at(-1)!, /Last error/);
  } finally {
    await h.close();
  }
});

test("a server down at session start is retried on later prompts without blocking Pi", async () => {
  const h = await harness();
  try {
    h.backend.down(true);
    await h.start();
    // Starting the session makes no request and reports no error.
    assert.equal(h.backend.calls.length, 0);
    assert.deepEqual(h.notifications, []);
    assert.match(h.statuses.at(-1)!, / · configured$/);

    // The agent runs normally while recording fails.
    await h.prompt("first");
    // No recording, so Pi's context is left as it is.
    const messages = [{ role: "user", content: "first", timestamp: 1 }];
    assert.equal(await h.emit("context_with_system", { messages }), undefined);
    await h.emit("agent_settled");
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0]!, /Recording retries on the next prompt/);
    await h.command("sovara");
    assert.match(h.notifications.at(-1)!, /Connection: last request failed/);

    // Once the server is back, the next prompt records without a reload.
    h.backend.down(false);
    await h.prompt("second");
    assert.equal(h.backend.to("/exec/traces").at(-1)?.body.name, "Pi session");
    assert.equal(h.backend.to("/turns").at(-1)?.body.turn_input, "second");
    await h.command("sovara");
    assert.match(h.notifications.at(-1)!, /Connection: connected/);
    assert.match(h.statuses.at(-1)!, / · recording$/);
  } finally {
    await h.close();
  }
});
