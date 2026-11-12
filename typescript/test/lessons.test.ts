import assert from "node:assert/strict";
import { test } from "vitest";
import { cleanMessages, referenceMessage } from "../src/lessons.ts";

test("old injections are left out of the recorded conversation without mutating it", () => {
  const user = { role: "user" as const, content: "task", timestamp: 1 };
  const messages = [user, referenceMessage("old lessons")];
  assert.deepEqual(cleanMessages(messages), [user]);
  assert.equal(messages.length, 2);
});
