import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const LESSON_MESSAGE = "sovara-lessons";
export function cleanMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(
    (message) =>
      !(message.role === "custom" && message.customType === LESSON_MESSAGE),
  );
}
export function referenceMessage(content: string): AgentMessage {
  return {
    role: "custom",
    customType: LESSON_MESSAGE,
    content,
    display: false,
    timestamp: Date.now(),
  };
}
