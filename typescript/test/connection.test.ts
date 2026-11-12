import assert from "node:assert/strict";
import { test } from "vitest";
import { bounded } from "../src/connection.ts";

test("bounded waits stop a second after Pi cancels, without unhandled rejections", async () => {
  let fail!: (error: Error) => void;
  const hung = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const controller = new AbortController();
  const waiting = bounded(hung, controller.signal);
  const started = Date.now();
  controller.abort();
  await assert.rejects(waiting, { name: "TimeoutError" });
  assert.ok(Date.now() - started < 1500);
  fail(new Error("late"));
  assert.equal(await bounded(Promise.resolve(3)), 3);
});
