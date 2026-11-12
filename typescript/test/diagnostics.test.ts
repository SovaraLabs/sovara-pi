import assert from "node:assert/strict";
import { CompatibilityError, RecordingError, SovaraConfigError } from "@sovara/sdk";
import { test } from "vitest";
import { explainError } from "../src/diagnostics.ts";

test("setup errors give safe, actionable instructions", () => {
  assert.match(
    explainError(new SovaraConfigError("Sovara rejected the request (HTTP 401): PRIVATE")),
    /sovara login.*next prompt/,
  );
  const override = {
    projectName: "p",
    execUrl: "http://127.0.0.1:5970",
    connectionKind: "override" as const,
    authentication: "none" as const,
  };
  assert.match(
    explainError(new SovaraConfigError("Sovara rejected the request (HTTP 401): PRIVATE"), override),
    /sign-in is for another server.*SOVARA_AGENT_TOKEN/,
  );
  assert.match(
    explainError(new SovaraConfigError("Sovara rejected the request (HTTP 403): PRIVATE")),
    /access this project/,
  );
  assert.match(
    explainError(new CompatibilityError("incompatible_contract", "PRIVATE")),
    /runner-api 6/,
  );
  assert.match(
    explainError(new RecordingError("unavailable", "PRIVATE")),
    /network or VPN\. Recording retries on the next prompt/,
  );
  for (const error of [
    new Error("PRIVATE CLI OUTPUT"),
    new SovaraConfigError("Sovara rejected the request (HTTP 422): PRIVATE"),
    new RecordingError("bad_request", "PRIVATE", { status: 400 }),
  ])
    assert.doesNotMatch(explainError(error), /PRIVATE/);
});
