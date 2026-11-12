import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage as PiUsage,
} from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type {
  ContentBlock,
  ConversationInput,
  ConversationOutput,
  JsonObject,
  JsonValue,
  Message,
  ToolSpec,
  Usage,
} from "@sovara/sdk";

type Part = TextContent | ThinkingContent | ImageContent | ToolCall;

function json<T extends JsonValue>(value: unknown): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function block(part: Part): ContentBlock {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "thinking":
      return part.redacted
        ? { type: "provider_block", format: "pi.thinking", data: { redacted: true } }
        : { type: "reasoning", text: part.thinking };
    case "image":
      return { type: "media", mime_type: part.mimeType, data: part.data };
    case "toolCall":
      return {
        type: "tool_call",
        call_id: part.id,
        name: part.name,
        arguments: json(part.arguments),
      };
  }
}

function blocks(content: string | readonly Part[]): ContentBlock[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content.map(block);
}

/** Text joined from text parts; images and other parts are left out. */
export function text(content: string | readonly Part[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function toolOutput(content: readonly (TextContent | ImageContent)[]): JsonValue {
  return content.every((part) => part.type === "text")
    ? text(content)
    : json(blocks(content));
}

/**
 * The conversation Pi sends to the model, as Sovara contract messages.
 *
 * Custom, bash and summary messages are first converted the way Pi converts them for the
 * model; summaries are marked as such. Each system message stays in place with its sections after its content, and the
 * tool changes of all system messages are replayed into the tool list.
 */
export function conversation(messages: AgentMessage[]): ConversationInput {
  const tools = new Map<string, ToolSpec>();
  const converted: Message[] = [];
  for (const original of messages) {
    // Pi sends summaries as user messages; Sovara marks them as standing in for history.
    const summary =
      original.role === "compactionSummary" || original.role === "branchSummary";
    for (const message of convertToLlm([original])) {
      if (message.role === "system") {
        for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
        for (const tool of message.toolsAdded ?? []) {
          tools.set(tool.name, {
            name: tool.name,
            description: tool.description,
            parameters: json<JsonObject>(tool.parameters),
          });
        }
        const content = blocks(message.content);
        for (const section of Object.values(message.sections ?? {})) {
          if (section !== null) content.push({ type: "text", text: section });
        }
        converted.push({ role: "system", content });
      } else if (message.role === "toolResult") {
        converted.push({
          role: "tool",
          content: [
            {
              type: "tool_result",
              call_id: message.toolCallId,
              is_error: message.isError,
              output: toolOutput(message.content),
            },
          ],
        });
      } else {
        converted.push({
          role: message.role,
          content: blocks(message.content),
          ...(summary ? { summary: true } : {}),
        });
      }
    }
  }
  return {
    format: "conversation",
    messages: converted,
    ...(tools.size ? { tools: [...tools.values()] } : {}),
  };
}

/** Pi reports uncached input separately, matching Sovara's token columns. */
export function usage(value: PiUsage | undefined): Usage | undefined {
  if (!value) return undefined;
  return {
    input_tokens: value.input,
    output_tokens: value.output,
    cache_read_tokens: value.cacheRead,
    cache_write_tokens: value.cacheWrite,
  };
}

export function output(message: AssistantMessage): ConversationOutput {
  const tokens = usage(message.usage);
  return {
    message: { role: "assistant", content: blocks(message.content) },
    stop_reason: message.stopReason,
    ...(tokens ? { usage: tokens } : {}),
  };
}

export function summaryOutput(summary: string, tokens?: PiUsage): ConversationOutput {
  const converted = usage(tokens);
  return {
    message: { role: "assistant", content: [{ type: "text", text: summary }] },
    ...(converted ? { usage: converted } : {}),
  };
}
