import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { test } from "vitest";
import { fixtureServer } from "./helpers.ts";

/**
 * Run one real Pi prompt with a synthetic model that reads a file, then answers. Records to
 * `execUrl`, or to a fixture server when omitted; returns what the model saw.
 */
export async function runPi(execUrl?: string) {
  const server = execUrl ? undefined : await fixtureServer();
  const cwd = await mkdtemp(join(tmpdir(), "pi-agent-test-"));
  const previous = {
    SOVARA_EXEC_SERVER_URL: process.env.SOVARA_EXEC_SERVER_URL,
    SOVARA_AGENT_TOKEN: process.env.SOVARA_AGENT_TOKEN,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.SOVARA_EXEC_SERVER_URL = execUrl ?? server!.config.execUrl;
  if (server) process.env.SOVARA_AGENT_TOKEN = "test-token";
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>["session"]
    | undefined;
  try {
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(cwd, ".pi", "sovara.json"),
      JSON.stringify({ projectName: "pi-fixture" }),
    );
    await writeFile(join(cwd, "input.txt"), "Synthetic test evidence");
    const agentDir = join(cwd, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-cache.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const inputs: unknown[] = [];
    let index = 0;
    modelRuntime.registerProvider("sovara-test", {
      api: "sovara-test-api",
      apiKey: "synthetic-key",
      baseUrl: "http://127.0.0.1:1",
      models: [
        {
          id: "synthetic",
          name: "Synthetic",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 4096,
        },
      ],
      streamSimple(model, context, options) {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          try {
            inputs.push(structuredClone(context));
            await options?.onPayload?.(
              { model: model.id, messages: context.messages },
              model,
            );
            const current = index++;
            const call =
              current === 0
                ? { name: "read", arguments: { path: "input.txt" } }
                : undefined;
            const message: AssistantMessage = {
              role: "assistant",
              api: "sovara-test-api",
              provider: "sovara-test",
              model: "synthetic",
              content: call
                ? [{ type: "toolCall", id: `call-${current}`, ...call }]
                : [{ type: "text", text: "Finished with deterministic tests." }],
              usage: {
                input: 10,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 15,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: call ? "toolUse" : "stop",
              timestamp: Date.now(),
            };
            stream.push({ type: "start", partial: message });
            stream.push({
              type: "done",
              reason: message.stopReason as "stop" | "toolUse",
              message,
            });
            stream.end();
          } catch (error) {
            stream.end();
            throw error;
          }
        })();
        return stream;
      },
    });
    const settings = SettingsManager.inMemory({
      defaultProjectTrust: "always",
      compaction: { enabled: false },
      cacheWarming: "off",
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      additionalExtensionPaths: [resolve(import.meta.dirname, "../src/index.ts")],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      disabledBuiltinExtensions: ["llama.cpp", "codemode", "tool-search"],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: modelRuntime.getModel("sovara-test", "synthetic")!,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: SessionManager.inMemory(cwd),
      tools: ["read"],
    });
    session = created.session;
    const errors: unknown[] = [];
    await session.bindExtensions({
      mode: "print",
      onError: (error) => {
        errors.push(error);
      },
    });
    await session.prompt("Inspect input.txt and explain how to test it.");
    assert.deepEqual(errors, []);
    return { server, inputs, sessionId: session.sessionManager.getSessionId() };
  } finally {
    await session?.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session?.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await server?.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("real Pi records the run and injects retrieved lessons into each model call", async () => {
  const { server, inputs } = await runPi();
  const calls = server!;
  assert.equal(inputs.length, 2);
  assert.ok(
    inputs.every((input) => JSON.stringify(input).includes("Use a deterministic clock.")),
  );
  // The server selects lessons when each model step starts; there is no separate retrieval.
  assert.equal(calls.to("/lesson-retrievals").length, 0);
  const steps = calls.to("/steps").map((call) => call.body);
  assert.deepEqual(steps.map((body) => body.lessons === true), [true, false, true]);
  assert.match(JSON.stringify(steps[2].call.input), /Synthetic test evidence/);

  const prepared = steps.map((body) => body.call);
  assert.deepEqual(prepared.map((call) => call.kind), ["llm", "tool", "llm"]);
  assert.equal(prepared[0].model, "synthetic");
  assert.ok(prepared[0].input.messages.some((m: { role: string }) => m.role === "system"));
  assert.deepEqual(prepared[0].input.tools.map((t: { name: string }) => t.name), ["read"]);
  assert.doesNotMatch(JSON.stringify(prepared[0].input), /Use a deterministic clock/);
  const finished = calls.to("/finalize").map((call) => call.body);
  assert.deepEqual(finished.map((body) => body.outcome.status), ["success", "success", "success"]);
  for (const body of [finished[0], finished[2]]) {
    assert.equal(body.execution.injected_retrieval_id, "retrieval-1");
    assert.match(JSON.stringify(body.execution.input), /Use a deterministic clock/);
  }
  assert.equal(
    calls.to("/exec/log-fields")[0]!.body.payload.trace_output,
    "Finished with deterministic tests.",
  );
  assert.ok(calls.to("/complete").length >= 1);
});
