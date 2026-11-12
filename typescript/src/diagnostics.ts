import {
  CompatibilityError,
  RecordingError,
  SovaraConfigError,
} from "@sovara/sdk";
import { ConfigError, type Config } from "./config.ts";

/** The HTTP status the SDK put in a rejected request's message, which is otherwise not shown. */
function rejectedStatus(error: SovaraConfigError): number | undefined {
  const match = /^Sovara rejected the request \(HTTP (\d{3})\)/.exec(error.message);
  return match ? Number(match[1]) : undefined;
}

const UNREACHABLE =
  "Cannot connect to the selected Sovara server. Sign in with `sovara login --url <url>` or check its URL, network or VPN. Recording retries on the next prompt.";

/** Only local, known messages are displayed; remote bodies and CLI stderr stay private. */
export function explainError(error: unknown, config?: Config): string {
  if (error instanceof ConfigError)
    return `${error.message}. Check your Sovara connection and .pi/sovara.json settings, then /reload.`;
  const status =
    error instanceof SovaraConfigError
      ? rejectedStatus(error)
      : error instanceof RecordingError
        ? (error.status ?? undefined)
        : undefined;
  if (status === 401) {
    if (config?.authentication === "agent-token")
      return "Sovara rejected the agent token. Check SOVARA_AGENT_TOKEN, then /reload.";
    if (config?.connectionKind === "override" && config.authentication === "none")
      return "Your saved Sovara sign-in is for another server, so it is not sent to this one. Use that server's URL or set SOVARA_AGENT_TOKEN, then /reload.";
    return "Sovara sign-in is missing or expired. Run `sovara login --url <url>`. Recording retries on the next prompt.";
  }
  if (status === 403)
    return "Sovara denied access. Check that your account or agent token can access this project. Recording retries on the next prompt.";
  if (error instanceof CompatibilityError)
    return "This Sovara server does not support runner-api 6. Install compatible Sovara/Pi extension versions, then /reload.";
  if (error instanceof RecordingError) {
    if (error.code === "unavailable") return UNREACHABLE;
    if (error.code === "timeout")
      return "Sovara did not respond in time. Check the selected server. Recording retries on the next prompt.";
    return `Sovara ${error.code}${status ? ` (HTTP ${status})` : ""}. Check the selected Sovara server. Recording retries on the next prompt.`;
  }
  if (error instanceof SovaraConfigError)
    return `Sovara rejected a request${status ? ` (HTTP ${status})` : ""}. Check the selected Sovara server. Recording retries on the next prompt.`;
  if (error instanceof Error && error.name === "TimeoutError")
    return "Sovara did not respond in time. Check the selected server. Recording retries on the next prompt.";
  if (error instanceof TypeError && "cause" in error) return UNREACHABLE;
  return "Sovara operation failed. Check your configuration and server, then /reload.";
}

/** Whether an error came from a request to Sovara (answered or not), not from local setup. */
export function fromServerRequest(error: unknown): boolean {
  return (
    error instanceof RecordingError ||
    error instanceof SovaraConfigError ||
    error instanceof CompatibilityError ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}

/** Whether a recording request has reached the server since the session started. */
export type ConnectionState = "not contacted yet" | "connected" | "last request failed";

export function connectionDetails(config: Config, connection: ConnectionState): string[] {
  const authentication = {
    "agent-token": "agent token configured",
    session: "saved sign-in session",
    expired: "saved session expired — run `sovara login`, then /reload",
    none: "no credentials configured (local servers may allow this)",
  }[config.authentication];
  return [
    `Server: ${config.execUrl}`,
    `Mode: ${{ override: "explicit URL override", "signed-in": "saved sign-in", default: "local default" }[config.connectionKind]}`,
    `Project: ${config.projectName}`,
    `Connection: ${connection}`,
    `Authentication: ${authentication}`,
  ];
}
