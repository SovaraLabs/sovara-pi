import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getTraceId, resumeRecording } from "@sovara/sdk";
import { test } from "vitest";
import type { Config } from "../../src/config.ts";
import { Recorder } from "../../src/recorder.ts";

/**
 * Against a real Sovara exec server: sovara's `tests.integration_backend`, run from a sovara
 * checkout (SOVARA_SOURCE_DIR, or ../sovara next to this repository) with the dev Postgres up.
 * It returns one fixed lesson and never calls a model. Run with `npm run test:e2e`.
 */
const source = resolve(process.env.SOVARA_SOURCE_DIR ?? "../../sovara");
const available = existsSync(join(source, "tests", "integration_backend.py"));

const model = { id: "gpt-test", provider: "openai" };
const answer = (text: string) =>
  ({
    role: "assistant",
    api: "openai-completions",
    provider: "openai",
    model: "gpt-test",
    timestamp: 1,
    content: [{ type: "text", text }],
    usage: {
      input: 12,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 19,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  }) as Parameters<Recorder["endGeneration"]>[0];

test.skipIf(!available)(
  "a real Sovara server stores the session's turns, steps and applied lessons",
  { timeout: 60_000 },
  async () => {
    const python =
      process.platform === "win32"
        ? join(source, ".venv", "Scripts", "python.exe")
        : join(source, ".venv", "bin", "python");
    const child = spawn(
      python,
      ["-m", "tests.integration_backend"],
      { cwd: source, stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      // Empty when the server exits first; its error is in the output above.
      const started = await Promise.race([once(child.stdout, "data"), once(child, "exit")]);
      const running = () => child.exitCode === null && child.signalCode === null;
      const url = running() ? String(started[0]).trim() : "";
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const config: Config = {
        projectName: `pi e2e ${crypto.randomUUID()}`,
        execUrl: url,
        connectionKind: "override",
        authentication: "agent-token",
        agentToken: "e2e-test",
      };
      const session = crypto.randomUUID();
      const recorder = new Recorder(config, session, fetch);

      await recorder.start("First turn");
      const traceId = await resumeRecording(recorder.handle!, async () => getTraceId()!, { fetch });
      const lessons = await fetch(`${url}/e2e/recordings/${traceId}/lessons`, { method: "POST" });
      assert.equal(lessons.status, 200);
      const first = [{ role: "user" as const, content: "First turn", timestamp: 1 }];
      const sent = await recorder.prepareGeneration(first, model);
      assert.equal(sent.length, 2);
      assert.match(JSON.stringify(sent.at(-1)), /Prefer small diffs/);
      await recorder.beginGeneration();
      await recorder.endGeneration(answer("Synthetic answer"));
      await recorder.beginTool("read-1", "read", { path: "example.txt" });
      await recorder.endTool("read-1", { content: [{ type: "text", text: "contents" }] }, false);
      await recorder.close();

      // The next prompt resumes the same trace; a provider retry is a step of its own.
      await recorder.start("Second turn");
      assert.equal(
        await resumeRecording(recorder.handle!, async () => getTraceId()!, { fetch }),
        traceId,
      );
      await fetch(`${url}/e2e/recordings/${traceId}/lessons`, { method: "POST" });
      const second = [
        ...first,
        { role: "user" as const, content: "Second turn", timestamp: 2 },
      ];
      await recorder.prepareGeneration(second, model);
      await recorder.beginGeneration();
      await recorder.beginGeneration();
      await recorder.endGeneration(answer("Retried answer"));
      await recorder.close();

      const recording = await (await fetch(`${url}/e2e/recordings/${traceId}`)).json();
      const steps = recording.steps.map((step: any) => [step.step_type, step.status]);
      assert.deepEqual(steps, [
        ["llm_call", "success"],
        ["tool_call", "success"],
        ["llm_call", "error"],
        ["llm_call", "success"],
      ]);
      // The first attempt was cancelled for the retry.
      assert.match(recording.steps[2].error_json, /cancelled/);
      assert.match(recording.steps[2].error_json, /ProviderRetry/);
      const llm = recording.steps[0];
      assert.equal(llm.input_tokens, 12);
      // The stored input is what was sent: the conversation, then the lessons.
      const messages = JSON.parse(llm.input_json).raw.body.messages;
      assert.deepEqual(
        messages.map((message: any) => message.content[0].text),
        ["First turn", "<lessons>Prefer small diffs.</lessons>"],
      );
      const applied = recording.lesson_retrievals
        .filter((row: any) => row.applied_lessons.length)
        .map((row: any) => row.step_uuid);
      assert.deepEqual(applied.sort(), [recording.steps[0].step_uuid, recording.steps[2].step_uuid].sort());
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, "exit");
      }
    }
  },
);
