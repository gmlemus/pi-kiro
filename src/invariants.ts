// Conversation invariants Kiro enforces, and the repair applied before every
// send (PROTOCOL.md §6, rules I1–I7 and I12). We repair rather than reject:
// the transcript belongs to the user, and a request we know is invalid would
// only come back as a 400 that wedges the session on every retry.

import { isAssistant, isUser, type KiroEntry, type KiroToolResult, toolResultsOf, toolUseIdsOf } from "./wire.ts";

export type Rule =
  | "STARTS_WITH_USER_MESSAGE"
  | "ENDS_WITH_USER_MESSAGE"
  | "ALTERNATING_MESSAGES"
  | "TOOL_USES_AND_RESULTS"
  | "TOOL_RESULTS_AND_NO_USES"
  | "TOOL_RESULTS_ORPHAN_IDS"
  | "NON_EMPTY_USER_MESSAGE";

export interface Violation {
  rule: Rule;
  index: number;
}

export const EMPTY_CONTENT_PLACEHOLDER = "Please proceed with the task.";
export const INTERRUPTED_TOOL_RESULT = "Tool use was interrupted and did not produce a result.";

const hasText = (e: KiroEntry | undefined) => isUser(e) && e.userInputMessage.content.trim() !== "";

export function validate(entries: KiroEntry[]): Violation[] {
  const out: Violation[] = [];
  const first = entries[0];
  if (!isUser(first) || (toolResultsOf(first).length > 0 && !hasText(first))) {
    out.push({ rule: "STARTS_WITH_USER_MESSAGE", index: 0 });
  }
  if (!isUser(entries[entries.length - 1])) out.push({ rule: "ENDS_WITH_USER_MESSAGE", index: entries.length - 1 });

  for (let i = 0; i < entries.length; i++) {
    const cur = entries[i];
    const prev = entries[i - 1];
    if (i > 0 && isUser(prev) === isUser(cur)) out.push({ rule: "ALTERNATING_MESSAGES", index: i });

    if (isAssistant(cur) && toolUseIdsOf(cur).length > 0) {
      const next = entries[i + 1];
      const uses = new Set(toolUseIdsOf(cur));
      const results = toolResultsOf(next).map((r) => r.toolUseId);
      const exact = isUser(next) && results.length === uses.size && results.every((id) => uses.has(id));
      if (!exact) out.push({ rule: "TOOL_USES_AND_RESULTS", index: i + 1 });
    }

    const results = toolResultsOf(cur);
    if (results.length > 0) {
      if (!isAssistant(prev) || toolUseIdsOf(prev).length === 0) {
        out.push({ rule: "TOOL_RESULTS_AND_NO_USES", index: i });
      } else {
        const valid = new Set(toolUseIdsOf(prev));
        const seen = new Set<string>();
        const bad = results.some((r) => {
          const dup = seen.has(r.toolUseId);
          seen.add(r.toolUseId);
          return dup || !valid.has(r.toolUseId);
        });
        if (bad) out.push({ rule: "TOOL_RESULTS_ORPHAN_IDS", index: i });
      }
    }

    if (isUser(cur) && !hasText(cur) && results.length === 0) out.push({ rule: "NON_EMPTY_USER_MESSAGE", index: i });
  }
  return out;
}

function joinText(a: string, b: string): string {
  return a && b ? `${a}\n\n${b}` : a || b;
}

/** Merge `b` into `a` when both entries have the same role. Returns a new entry. */
export function mergeEntries(a: KiroEntry, b: KiroEntry): KiroEntry {
  if (isUser(a) && isUser(b)) {
    const x = a.userInputMessage;
    const y = b.userInputMessage;
    const images = [...(x.images ?? []), ...(y.images ?? [])];
    const results = [...(x.userInputMessageContext?.toolResults ?? []), ...(y.userInputMessageContext?.toolResults ?? [])];
    return {
      userInputMessage: {
        content: joinText(x.content, y.content),
        modelId: x.modelId,
        origin: x.origin,
        ...(images.length > 0 ? { images } : {}),
        ...(results.length > 0 ? { userInputMessageContext: { toolResults: results } } : {}),
      },
    };
  }
  if (isAssistant(a) && isAssistant(b)) {
    const uses = [...(a.assistantResponseMessage.toolUses ?? []), ...(b.assistantResponseMessage.toolUses ?? [])];
    return {
      assistantResponseMessage: {
        content: joinText(a.assistantResponseMessage.content, b.assistantResponseMessage.content),
        ...(uses.length > 0 ? { toolUses: uses } : {}),
      },
    };
  }
  throw new Error("mergeEntries: roles differ");
}

function withToolResults(entry: KiroEntry, results: KiroToolResult[]): KiroEntry {
  if (!isUser(entry)) return entry;
  const { userInputMessageContext, ...rest } = entry.userInputMessage;
  const ctx = { ...userInputMessageContext };
  if (results.length > 0) ctx.toolResults = results;
  else delete ctx.toolResults;
  return { userInputMessage: { ...rest, ...(Object.keys(ctx).length > 0 ? { userInputMessageContext: ctx } : {}) } };
}

const interrupted = (toolUseId: string): KiroToolResult => ({
  toolUseId,
  status: "error",
  content: [{ text: INTERRUPTED_TOOL_RESULT }],
});

export interface RepairResult {
  entries: KiroEntry[];
  /** Violations in the input. */
  found: Violation[];
  /** Violations still present after repair; non-empty means the request may be rejected. */
  remaining: Violation[];
}

/**
 * Repair, in order:
 *  1. drop leading assistant entries; strip tool results from a leading user entry
 *     (dropping it if it then carries nothing);
 *  2. merge adjacent same-role entries;
 *  3. strip tool results that answer nothing in the preceding assistant turn, and duplicates;
 *  4. answer every unanswered tool use with a synthetic error result;
 *  5. give a user entry with neither text nor results a neutral placeholder.
 * Deterministic: the same input always yields byte-identical output, so a
 * retried request is stable.
 */
export function repair(input: KiroEntry[], modelId: string): RepairResult {
  const found = validate(input);
  if (found.length === 0) return { entries: input, found, remaining: [] };

  // 1.
  let work = [...input];
  while (work.length > 0 && !isUser(work[0])) work.shift();
  if (work.length > 0 && toolResultsOf(work[0]).length > 0) {
    const head = withToolResults(work[0] as KiroEntry, []);
    if (hasText(head) || (isUser(head) && (head.userInputMessage.images?.length ?? 0) > 0)) work[0] = head;
    else work.shift();
  }

  // 2.
  const merged: KiroEntry[] = [];
  for (const e of work) {
    const last = merged[merged.length - 1];
    if (last && isUser(last) === isUser(e)) merged[merged.length - 1] = mergeEntries(last, e);
    else merged.push(e);
  }

  // 3 + 4.
  const out: KiroEntry[] = [];
  for (let i = 0; i < merged.length; i++) {
    let e = merged[i] as KiroEntry;
    if (isUser(e)) {
      const prev = out[out.length - 1];
      const valid = new Set(toolUseIdsOf(prev));
      const seen = new Set<string>();
      const kept = toolResultsOf(e).filter((r) => {
        if (!valid.has(r.toolUseId) || seen.has(r.toolUseId)) return false;
        seen.add(r.toolUseId);
        return true;
      });
      // Answer every use the previous turn issued, in issue order.
      const missing = [...valid].filter((id) => !seen.has(id));
      e = withToolResults(e, [...kept, ...missing.map(interrupted)]);
      out.push(e);
      continue;
    }
    out.push(e);
    const uses = toolUseIdsOf(e);
    if (uses.length > 0 && !isUser(merged[i + 1])) {
      out.push({
        userInputMessage: {
          content: "",
          modelId,
          origin: "KIRO_CLI",
          userInputMessageContext: { toolResults: uses.map(interrupted) },
        },
      });
    }
  }

  // 5. An assistant-final conversation also needs a user turn to answer.
  if (!isUser(out[out.length - 1])) {
    out.push({ userInputMessage: { content: EMPTY_CONTENT_PLACEHOLDER, modelId, origin: "KIRO_CLI" } });
  }
  const final = out.map((e) =>
    isUser(e) && !hasText(e) && toolResultsOf(e).length === 0
      ? { userInputMessage: { ...e.userInputMessage, content: EMPTY_CONTENT_PLACEHOLDER } }
      : e,
  );
  return { entries: final, found, remaining: validate(final) };
}
