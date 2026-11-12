# Changelog

## Unreleased

- Move the extension into its own repository and record through `@sovara/sdk`: model calls, tools and MCP calls, and compaction and branch summaries become typed steps, and lessons are applied to the model step that received them.
- Require Node.js 24.22.1 or newer and a compatible Sovara server.
- Pass subagents a recording handle through an owner-only file that is removed when the turn ends, not through the environment; a parent and subagent on different extension versions are rejected with an update message.
- Use the server saved by `sovara login` instead of the Sovara Desktop connection. Pi no longer starts a local server.
- The server now selects each model call's lessons when its step starts, from the recorded conversation; Pi no longer builds its own retrieval query. Compaction and branch summaries are marked so retrieval treats them as background. Each provider retry is its own model step.
- Start sessions without a network check. The first prompt connects through the SDK; if Sovara is unavailable, Pi runs normally and the next prompt tries again, without a `/reload`. While it stays unreachable, each prompt can wait up to 5 seconds for it. `/sovara` shows whether the server has been reached.
- Server-side lesson retrieval warnings are no longer shown, and model steps no longer record the raw provider payload or time to first token.

## 0.1.3 — 2026-11-07

- Restore Pi trace recording and lesson retrieval with current Sovara servers.
- Update child-session credential handling while preserving masking for both legacy and current token names.
- Require a compatible Sovara server; older servers must be upgraded.
