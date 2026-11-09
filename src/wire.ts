// Kiro request shapes (PROTOCOL.md §3).

export const ORIGIN = "KIRO_CLI";

export interface KiroImage {
  format: string;
  source: { bytes: string };
}

export interface KiroToolSpec {
  toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, unknown> } };
}

export interface KiroToolUse {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface KiroToolResult {
  toolUseId: string;
  status: "success" | "error";
  content: Array<{ text: string }>;
}

export interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: typeof ORIGIN;
  images?: KiroImage[];
  userInputMessageContext?: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] };
}

export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: KiroToolUse[];
}

export type KiroEntry = { userInputMessage: KiroUserInputMessage } | { assistantResponseMessage: KiroAssistantResponseMessage };

export interface KiroChatRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    agentTaskType: "vibe";
    conversationId: string;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: KiroEntry[];
  };
  agentMode: "vibe";
  profileArn: string;
  additionalModelRequestFields?: Record<string, unknown>;
}

export function isUser(e: KiroEntry | undefined): e is { userInputMessage: KiroUserInputMessage } {
  return !!e && "userInputMessage" in e;
}

export function isAssistant(e: KiroEntry | undefined): e is { assistantResponseMessage: KiroAssistantResponseMessage } {
  return !!e && "assistantResponseMessage" in e;
}

export function toolResultsOf(e: KiroEntry | undefined): KiroToolResult[] {
  return isUser(e) ? (e.userInputMessage.userInputMessageContext?.toolResults ?? []) : [];
}

export function toolUseIdsOf(e: KiroEntry | undefined): string[] {
  return isAssistant(e) ? (e.assistantResponseMessage.toolUses ?? []).map((u) => u.toolUseId) : [];
}
