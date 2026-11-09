// pi transcript -> Kiro conversation (PROTOCOL.md §3.3–3.5, §6).

import { createHash } from "node:crypto";
import type { AssistantMessage, ImageContent, Message, TextContent, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { KiroError } from "./errors.ts";
import { EMPTY_CONTENT_PLACEHOLDER, type RepairResult, repair } from "./invariants.ts";
import {
  isUser,
  type KiroEntry,
  type KiroImage,
  type KiroToolResult,
  type KiroToolSpec,
  type KiroToolUse,
  type KiroUserInputMessage,
  ORIGIN,
  toolResultsOf,
} from "./wire.ts";

export const TOOL_RESULT_CHAR_LIMIT = 250_000;
/** History budget in JSON characters for a 200k-token window; scaled by the model's window (I13). */
export const HISTORY_CHAR_LIMIT_AT_200K = 850_000;
/** Base64 budget for the one image-bearing history turn that is retained (I13). */
export const HISTORY_IMAGE_BASE64_LIMIT = 512 * 1024;

const TOOL_USE_ID = /^[a-zA-Z0-9_.:-]{1,64}$/;

/** Keep valid IDs; map any other ID deterministically so uses and results still pair (I9). */
export function toKiroToolUseId(id: string): string {
  if (TOOL_USE_ID.test(id)) return id;
  return `pi_${createHash("sha256").update(id).digest("base64url").slice(0, 32)}`;
}

/** Replace unpaired UTF-16 surrogates (I11). */
export function wellFormed(text: string): string {
  return text.toWellFormed();
}

function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n... [truncated ${text.length - limit} characters] ...\n${text.slice(text.length - half)}`;
}

function toImage(img: ImageContent): KiroImage {
  return { format: img.mimeType.split("/")[1]?.toLowerCase() || "png", source: { bytes: img.data } };
}

function userParts(content: string | (TextContent | ImageContent)[]): { text: string; images: KiroImage[] } {
  if (typeof content === "string") return { text: content, images: [] };
  const text = content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
  const images = content.filter((c): c is ImageContent => c.type === "image").map(toImage);
  return { text, images };
}

function userEntry(content: string, images: KiroImage[], modelId: string, results?: KiroToolResult[]): KiroEntry {
  const uim: KiroUserInputMessage = { content: wellFormed(content), modelId, origin: ORIGIN };
  if (images.length > 0) uim.images = images;
  if (results && results.length > 0) uim.userInputMessageContext = { toolResults: results };
  return { userInputMessage: uim };
}

function assistantEntry(msg: AssistantMessage): KiroEntry | undefined {
  if (msg.content.length === 0) return undefined;
  let text = "";
  const toolUses: KiroToolUse[] = [];
  for (const block of msg.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "toolCall") {
      toolUses.push({ toolUseId: toKiroToolUseId(block.id), name: block.name, input: { ...block.arguments } });
    }
    // Thinking is deliberately not replayed into the text channel (PROTOCOL.md C1).
    // A thinking-only turn is kept with empty content so alternation holds.
  }
  return {
    assistantResponseMessage: { content: wellFormed(text), ...(toolUses.length > 0 ? { toolUses } : {}) },
  };
}

function toolResultEntry(msg: ToolResultMessage, modelId: string): KiroEntry {
  const text = msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
  const images = msg.content.filter((c): c is ImageContent => c.type === "image").map(toImage);
  const result: KiroToolResult = {
    toolUseId: toKiroToolUseId(msg.toolCallId),
    status: msg.isError ? "error" : "success",
    content: [{ text: wellFormed(truncateMiddle(text, TOOL_RESULT_CHAR_LIMIT)) }],
  };
  // Content is empty by design: toolResults is the payload (PROTOCOL.md C2).
  return userEntry("", images, modelId, [result]);
}

/**
 * Move each tool result to sit right after the assistant turn that issued its
 * call. A pure reorder: interleaved concurrent tool runs otherwise leave a
 * result behind a later turn, which Kiro rejects (I12).
 */
export function relocateToolResults(messages: Message[]): Message[] {
  const pending = [...messages];
  const out: Message[] = [];
  while (pending.length > 0) {
    const msg = pending.shift() as Message;
    out.push(msg);
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "toolCall") continue;
      const at = pending.findIndex((m) => m.role === "toolResult" && m.toolCallId === block.id);
      if (at >= 0) out.push(...pending.splice(at, 1));
    }
  }
  return out;
}

function pushMerged(entries: KiroEntry[], entry: KiroEntry): void {
  const last = entries[entries.length - 1];
  if (last && isUser(last) && isUser(entry)) {
    const a = last.userInputMessage;
    const b = entry.userInputMessage;
    a.content = a.content && b.content ? `${a.content}\n\n${b.content}` : a.content || b.content;
    if (b.images) a.images = [...(a.images ?? []), ...b.images];
    const results = toolResultsOf(entry);
    if (results.length > 0) {
      a.userInputMessageContext = { toolResults: [...toolResultsOf(last), ...results] };
    }
    return;
  }
  if (last && !isUser(last) && !isUser(entry)) {
    const a = last.assistantResponseMessage;
    const b = entry.assistantResponseMessage;
    a.content = a.content && b.content ? `${a.content}\n\n${b.content}` : a.content || b.content;
    if (b.toolUses) a.toolUses = [...(a.toolUses ?? []), ...b.toolUses];
    return;
  }
  entries.push(entry);
}

/** Keep only the newest image-bearing history turn, and only if it fits the budget (I13). */
function boundHistoryImages(history: KiroEntry[]): void {
  let newest = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (isUser(e) && (e.userInputMessage.images?.length ?? 0) > 0) {
      newest = i;
      break;
    }
  }
  history.forEach((e, i) => {
    if (!isUser(e) || !e.userInputMessage.images) return;
    const size = e.userInputMessage.images.reduce((s, img) => s + img.source.bytes.length, 0);
    if (i !== newest || size > HISTORY_IMAGE_BASE64_LIMIT) delete e.userInputMessage.images;
  });
}

export function toKiroTools(tools: Tool[]): KiroToolSpec[] {
  return tools.map((t) => ({
    toolSpecification: {
      name: t.name,
      description: t.description || t.name,
      inputSchema: { json: JSON.parse(JSON.stringify(t.parameters)) as Record<string, unknown> },
    },
  }));
}

/** Every tool name used in history must be declared, or Kiro rejects the request (I8). */
function coverHistoryTools(history: KiroEntry[], tools: KiroToolSpec[]): KiroToolSpec[] {
  const declared = new Set(tools.map((t) => t.toolSpecification.name));
  const extra: KiroToolSpec[] = [];
  for (const e of history) {
    if (isUser(e)) continue;
    for (const use of e.assistantResponseMessage.toolUses ?? []) {
      if (declared.has(use.name)) continue;
      declared.add(use.name);
      extra.push({
        toolSpecification: {
          name: use.name,
          description: "This tool is no longer available. Do not call it.",
          inputSchema: { json: { type: "object", properties: {} } },
        },
      });
    }
  }
  return [...tools, ...extra];
}

export interface BuildInput {
  messages: Message[];
  modelId: string;
  systemPrompt: string;
  tools: Tool[];
  contextWindow: number;
}

export interface BuiltConversation {
  history: KiroEntry[];
  current: KiroUserInputMessage;
  repair: RepairResult;
}

export function buildConversation(input: BuildInput): BuiltConversation {
  const { modelId } = input;
  const messages = relocateToolResults(
    input.messages.filter(
      (m) => m.role !== "system" && !(m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")),
    ),
  );

  const entries: KiroEntry[] = [];
  for (const msg of messages) {
    let entry: KiroEntry | undefined;
    if (msg.role === "user") {
      const { text, images } = userParts(msg.content);
      entry = userEntry(text, images, modelId);
    } else if (msg.role === "assistant") {
      entry = assistantEntry(msg);
    } else if (msg.role === "toolResult") {
      entry = toolResultEntry(msg, modelId);
    } else if ((msg as { role: string }).role === "developer") {
      // Hosts may emit a developer role; Kiro has none, so it becomes user input.
      const { text, images } = userParts((msg as { content: string | (TextContent | ImageContent)[] }).content);
      entry = userEntry(text, images, modelId);
    }
    if (entry) pushMerged(entries, entry);
  }
  if (entries.length === 0) entries.push(userEntry("", [], modelId));

  const repaired = repair(entries, modelId);
  const all = repaired.entries;
  // Repair always ends on a user entry, which becomes the current message.
  const current = (all[all.length - 1] as { userInputMessage: KiroUserInputMessage }).userInputMessage;
  const history = all.slice(0, -1);

  // No system field exists: the prompt prefixes the first user message (§3.3).
  if (input.systemPrompt) {
    const first = (history.find(isUser)?.userInputMessage ?? current) as KiroUserInputMessage;
    first.content = first.content ? `${wellFormed(input.systemPrompt)}\n\n${first.content}` : wellFormed(input.systemPrompt);
  }

  boundHistoryImages(history);
  const limit = Math.floor((HISTORY_CHAR_LIMIT_AT_200K * input.contextWindow) / 200_000);
  const size = JSON.stringify(history).length;
  if (size > limit) {
    throw new KiroError(
      "tooLarge",
      `context_length_exceeded: conversation history is ${size} characters, over the ${limit}-character budget for this model`,
    );
  }

  const tools = coverHistoryTools(history, toKiroTools(input.tools));
  if (tools.length > 0) current.userInputMessageContext = { ...current.userInputMessageContext, tools };
  if (current.content.trim() === "" && toolResultsOf({ userInputMessage: current }).length === 0) {
    current.content = EMPTY_CONTENT_PLACEHOLDER;
  }
  return { history, current, repair: repaired };
}
