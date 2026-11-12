import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { test } from "vitest";
import { conversation, output } from "../src/convert.ts";
import { referenceMessage } from "../src/lessons.ts";

const tool = (name: string) => ({
  name,
  description: `${name} a file`,
  parameters: { type: "object", properties: { path: { type: "string" } } },
});

test("system messages keep their sections in place and replay tool changes", () => {
  const messages = [
    {
      role: "system",
      content: "base prompt",
      sections: { rules: "<rules>be brief</rules>", gone: null },
      toolsAdded: [tool("read"), tool("write")],
      timestamp: 1,
    },
    { role: "user", content: "hi", timestamp: 2 },
    { role: "system", content: [], toolsRemoved: [{ name: "write" }], timestamp: 3 },
  ] as AgentMessage[];

  assert.deepEqual(conversation(messages), {
    format: "conversation",
    messages: [
      {
        role: "system",
        content: [
          { type: "text", text: "base prompt" },
          { type: "text", text: "<rules>be brief</rules>" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "system", content: [] },
    ],
    tools: [tool("read")],
  });
});

test("assistant parts, images, tool results and lesson messages map to contract blocks", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", data: "aW1n", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
      ],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "contents" }],
      isError: false,
      timestamp: 3,
    },
    referenceMessage("Use a deterministic clock."),
  ] as AgentMessage[];

  const [user, assistant, result, lesson] = conversation(messages).messages;
  assert.deepEqual(user!.content, [
    { type: "text", text: "look" },
    { type: "media", mime_type: "image/png", data: "aW1n" },
  ]);
  assert.deepEqual(assistant!.content, [
    { type: "reasoning", text: "plan" },
    { type: "provider_block", format: "pi.thinking", data: { redacted: true } },
    { type: "tool_call", call_id: "c1", name: "read", arguments: { path: "a" } },
  ]);
  assert.deepEqual(result, {
    role: "tool",
    content: [{ type: "tool_result", call_id: "c1", is_error: false, output: "contents" }],
  });
  assert.equal(lesson!.role, "user");
  assert.match(JSON.stringify(lesson!.content), /Use a deterministic clock/);
});

test("compaction and branch summaries are marked as standing in for history", () => {
  const messages = [
    { role: "compactionSummary", summary: "Earlier work.", tokensBefore: 10, timestamp: 1 },
    { role: "branchSummary", summary: "Other branch.", fromId: "e1", timestamp: 2 },
    { role: "user", content: "continue", timestamp: 3 },
  ] as AgentMessage[];
  const converted = conversation(messages).messages;
  assert.deepEqual(converted.map((m) => [m.role, m.summary ?? false]), [
    ["user", true],
    ["user", true],
    ["user", false],
  ]);
  assert.match(JSON.stringify(converted[0]!.content), /Earlier work\./);
});

test("assistant output carries the stop reason and normalized usage", () => {
  assert.deepEqual(
    output({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "test",
      provider: "test",
      model: "m",
      usage: {
        input: 5,
        output: 3,
        cacheRead: 1,
        cacheWrite: 0,
        totalTokens: 9,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "length",
      timestamp: 1,
    }),
    {
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      stop_reason: "length",
      usage: { input_tokens: 5, output_tokens: 3, cache_read_tokens: 1, cache_write_tokens: 0 },
    },
  );
});
