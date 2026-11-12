import { createServer } from "node:http";
import type { Config } from "../src/config.ts";

export interface Call {
  method: string;
  path: string;
  body: any;
  headers: Record<string, unknown>;
}

/** A runner-api 6 exec server on a local port that records every request. */
export async function fixtureServer() {
  const calls: Call[] = [];
  let rejectPath: RegExp | undefined;
  let blockedPath: RegExp | undefined;
  let reached: (() => void) | undefined;
  let versions: unknown = [5, 6];
  let down = false;
  let lessons: { retrieval_id: string; text: string } | null = {
    retrieval_id: "retrieval-1",
    text: "Use a deterministic clock.",
  };
  let traces = 0;
  let turns = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = req.url!;
    const body = raw ? JSON.parse(raw) : {};
    // Step payloads arrive as {storage: "inline", value}; tests read the values.
    for (const key of ["call", "outcome", "execution"])
      if (body[key]?.storage === "inline") body[key] = body[key].value;
    calls.push({ method: req.method!, path, body, headers: req.headers });
    if (down) {
      res.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (blockedPath?.test(path)) {
      blockedPath = undefined;
      reached?.();
      return;
    }
    if (rejectPath?.test(path)) {
      res
        .writeHead(400)
        .end(JSON.stringify({ error: "bad_request", message: "PRIVATE ERROR PAYLOAD" }));
      return;
    }
    let response: unknown = { ok: true };
    const recording = () => {
      traces += 1;
      return {
        trace_id: `trace-${traces}`,
        recording_id: `recording-${traces}`,
        trace_write_token: "recording-secret",
        project_id: "project-fixture",
        appended: false,
      };
    };
    if (path === "/exec/health")
      response = {
        status: "ok",
        service: "sovara-exec-server",
        compatibility: {
          component: "exec-server",
          contracts: { "runner-api": versions },
        },
        features: {},
      };
    else if (path === "/exec/traces") response = recording();
    else if (path.endsWith("/subtraces")) {
      const { project_id: _, ...child } = recording();
      response = child;
    } else if (path.endsWith("/turns")) {
      turns += 1;
      response = { recording_id: `recording-${traces}`, turn_id: `turn-${turns}` };
    } else if (path.endsWith("/steps") || path.endsWith("/steps/record"))
      response = {
        ok: true,
        step_uuid: body.step_uuid,
        lesson_context: body.lessons ? lessons : null,
        prepared_request: null,
      };
    else if (path.endsWith("/lesson-retrievals"))
      response = { ok: true, lesson_context: lessons };
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const config: Config = {
    projectName: "fixture",
    execUrl: `http://127.0.0.1:${address.port}`,
    agentToken: "agent-secret",
    connectionKind: "override",
    authentication: "agent-token",
  };
  return {
    calls,
    config,
    /** Requests whose path ends with suffix. */
    to: (suffix: string) => calls.filter((call) => call.path.endsWith(suffix)),
    reject(path?: RegExp) {
      rejectPath = path;
    },
    blockNext(path: RegExp): Promise<void> {
      blockedPath = path;
      return new Promise((resolve) => {
        reached = resolve;
      });
    },
    /** Drop every connection without answering, like a server that is down. */
    down(value: boolean) {
      down = value;
    },
    versions(value: unknown) {
      versions = value;
    },
    lessons(value: { retrieval_id: string; text: string } | null) {
      lessons = value;
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
