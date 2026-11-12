import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Recorder } from "../src/recorder.ts";
import { fixtureServer } from "./helpers.ts";

test("saved sign-in session authenticates recording at its runner origin", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-remote-auth-"));
  const server = await fixtureServer();
  const previousHome = process.env.HOME;
  // The SDK reads the saved sign-in session from the home directory.
  process.env.HOME = home;
  try {
    await mkdir(join(home, ".sovara"));
    await writeFile(
      join(home, ".sovara/app_session.json"),
      JSON.stringify({
        version: 1,
        origin: "https://app.example",
        runner_origin: `${server.config.execUrl}/`,
        session_token: "synthetic-session",
        expires_at: "2099-01-01",
      }),
    );
    const config = await loadConfig(home, home, {});
    assert.equal(config.connectionKind, "signed-in");
    assert.equal(config.execUrl, server.config.execUrl);
    assert.equal(config.authentication, "session");
    const recorder = new Recorder(config, "remote-fixture", fetch);
    await recorder.start("hi");
    assert.equal(
      server.calls.find((call) => call.path === "/exec/traces")?.headers[
        "x-sovara-platform-session"
      ],
      "synthetic-session",
    );
    await recorder.close();
  } finally {
    process.env.HOME = previousHome;
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a server other than the signed-in one never receives the saved session", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-other-server-"));
  const server = await fixtureServer();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await mkdir(join(home, ".sovara"));
    await writeFile(
      join(home, ".sovara/app_session.json"),
      JSON.stringify({
        version: 1,
        origin: "https://app.example",
        session_token: "synthetic-session",
        expires_at: "2099-01-01",
      }),
    );
    const config = await loadConfig(home, home, {
      SOVARA_EXEC_SERVER_URL: server.config.execUrl,
    });
    assert.equal(config.authentication, "none");
    const recorder = new Recorder(config, "other-server", fetch);
    await recorder.start("hi");
    assert.ok(server.calls.length > 0);
    assert.ok(server.calls.every((call) => !("x-sovara-platform-session" in call.headers)));
    await recorder.close();
  } finally {
    process.env.HOME = previousHome;
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("project defaults and overrides", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-config-"));
  const cwd = join(home, "my-project");
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    assert.equal((await loadConfig(cwd, home, {})).projectName, "my-project");
    await writeFile(
      join(cwd, ".pi", "sovara.json"),
      JSON.stringify({ projectName: "shared-project" }),
    );
    const config = await loadConfig(cwd, home, {});
    assert.equal(config.projectName, "shared-project");
    assert.equal(config.agentToken, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("workspace cannot redirect credentials; session tokens stay on the saved origin", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-config-"));
  const cwd = join(home, "repo");
  try {
    await mkdir(join(home, ".sovara"), { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(home, ".sovara", "app_session.json"),
      JSON.stringify({
        version: 1,
        origin: "https://sovara.example",
        session_token: "secret",
        expires_at: "2099-01-01",
      }),
    );
    assert.equal((await loadConfig(cwd, home, {})).authentication, "session");
    assert.equal(
      (
        await loadConfig(cwd, home, {
          SOVARA_EXEC_SERVER_URL: "https://different.example",
        })
      ).authentication,
      "none",
    );
    await writeFile(
      join(cwd, ".pi", "sovara.json"),
      JSON.stringify({ execUrl: "https://evil.example" }),
    );
    await assert.rejects(loadConfig(cwd, home, {}), /only projectName/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("malformed configuration and unsupported keys fail explicitly", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-config-"));
  try {
    await mkdir(join(home, ".pi"));
    await writeFile(join(home, ".pi", "sovara.json"), "{");
    await assert.rejects(loadConfig(home, home, {}), /Invalid/);
    await writeFile(join(home, ".pi", "sovara.json"), '{"unknown":true}');
    await assert.rejects(loadConfig(home, home, {}), /only projectName/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the server follows the env, then the Pi setting, then the sign-in, then the default", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-server-config-"));
  try {
    await mkdir(join(home, ".sovara"));
    await mkdir(join(home, "agent"));
    const env = { PI_CODING_AGENT_DIR: join(home, "agent") };
    const server = async (extra: Record<string, string> = {}) => {
      const config = await loadConfig(home, home, { ...env, ...extra });
      return [config.execUrl, config.connectionKind];
    };
    assert.deepEqual(await server(), ["http://127.0.0.1:5960", "default"]);
    await writeFile(
      join(home, ".sovara", "app_session.json"),
      JSON.stringify({ version: 1, origin: "https://app.example/" }),
    );
    assert.deepEqual(await server(), ["https://app.example", "signed-in"]);
    await writeFile(
      join(home, ".sovara", "app_session.json"),
      JSON.stringify({
        version: 1,
        origin: "https://app.example",
        runner_origin: "https://exec.example",
      }),
    );
    assert.deepEqual(await server(), ["https://exec.example", "signed-in"]);
    await writeFile(
      join(home, "agent", "sovara.json"),
      JSON.stringify({ execUrl: "http://127.0.0.1:5970" }),
    );
    assert.deepEqual(await server(), ["http://127.0.0.1:5970", "override"]);
    assert.deepEqual(
      await server({ SOVARA_EXEC_SERVER_URL: "https://env.example" }),
      ["https://env.example", "override"],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("connection diagnostics distinguish saved sign-in, expired session and explicit token", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-diagnostics-config-"));
  try {
    await mkdir(join(home, ".sovara"));
    await writeFile(
      join(home, ".sovara", "app_session.json"),
      JSON.stringify({
        version: 1,
        origin: "https://remote.example",
        session_token: "private-expired-session",
        expires_at: "2000-01-01",
      }),
    );
    const expired = await loadConfig(home, home, {});
    assert.equal(expired.connectionKind, "signed-in");
    assert.equal(expired.execUrl, "https://remote.example");
    assert.equal(expired.authentication, "expired");
    assert.equal(expired.agentToken, undefined);
    const token = await loadConfig(home, home, {
      SOVARA_AGENT_TOKEN: "private-agent-token",
    });
    assert.equal(token.authentication, "agent-token");
    assert.equal(token.connectionKind, "signed-in");
    const override = await loadConfig(home, home, {
      SOVARA_EXEC_SERVER_URL: "http://127.0.0.1:5970",
    });
    assert.equal(override.connectionKind, "override");
    assert.equal(override.authentication, "none");
    await assert.rejects(
      loadConfig(home, home, {
        SOVARA_EXEC_SERVER_URL: "invalid-private-origin",
      }),
      /Invalid Sovara server origin/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
