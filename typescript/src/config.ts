import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface Config {
  projectName: string;
  execUrl: string;
  connectionKind: "signed-in" | "default" | "override";
  authentication: "agent-token" | "session" | "expired" | "none";
  /** From SOVARA_AGENT_TOKEN; a secret, never shown or logged. */
  agentToken?: string;
}

export class ConfigError extends Error {}

async function readJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new ConfigError();
    return data as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError("Invalid or unreadable Sovara configuration");
  }
}

function origin(value: unknown): string {
  if (typeof value !== "string")
    throw new ConfigError("Sovara server URL must be an origin");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("Invalid Sovara server origin");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new ConfigError("Invalid Sovara server origin");
  return url.origin;
}

const DEFAULT_EXEC_URL = "http://127.0.0.1:5960";

/** A saved sign-in URL as an origin, or undefined when it is missing or not one. */
function savedOrigin(value: unknown): string | undefined {
  try {
    return origin(typeof value === "string" ? value.replace(/\/+$/, "") + "/" : value);
  } catch {
    return undefined;
  }
}

export async function loadConfig(
  cwd: string,
  home = homedir(),
  env = process.env,
  projectTrusted = true,
): Promise<Config> {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
  const global = (await readJson(join(agentDir, "sovara.json"))) ?? {};
  if (
    Object.keys(global).some((key) => !["projectName", "execUrl"].includes(key))
  )
    throw new ConfigError(
      "User Sovara config supports only projectName and execUrl",
    );
  const local = projectTrusted
    ? ((await readJson(join(cwd, ".pi", "sovara.json"))) ?? {})
    : {};
  // A checked-in project file cannot redirect credentials to a different server.
  if (Object.keys(local).some((key) => !["projectName"].includes(key))) {
    throw new ConfigError("Project Sovara config supports only projectName");
  }
  const projectName =
    local.projectName ?? global.projectName ?? basename(resolve(cwd));
  if (typeof projectName !== "string" || !projectName.trim())
    throw new ConfigError("A project name is required");
  // `sovara login` saves the server it signed in to, and its exec-server origin when that
  // differs. The saved session is sent only to that server.
  const session = await readJson(join(home, ".sovara", "app_session.json"));
  const signedIn =
    session?.version === 1
      ? (savedOrigin(session.runner_origin) ?? savedOrigin(session.origin))
      : undefined;
  const execUrl = origin(
    env.SOVARA_EXEC_SERVER_URL ?? global.execUrl ?? signedIn ?? DEFAULT_EXEC_URL,
  );
  const agentToken = env.SOVARA_AGENT_TOKEN?.trim() || undefined;
  let authentication: Config["authentication"] = "none";
  if (agentToken) {
    authentication = "agent-token";
  } else if (session && execUrl === signedIn) {
    if (
      typeof session.session_token === "string" &&
      typeof session.expires_at === "string"
    ) {
      // Only reported in /sovara: the SDK itself sends the session to this server only.
      authentication =
        Date.parse(session.expires_at) > Date.now() ? "session" : "expired";
    }
  }
  const override =
    env.SOVARA_EXEC_SERVER_URL !== undefined || global.execUrl !== undefined;
  return {
    connectionKind: override ? "override" : signedIn ? "signed-in" : "default",
    authentication,
    projectName: projectName.trim(),
    execUrl,
    ...(agentToken ? { agentToken } : {}),
  };
}
