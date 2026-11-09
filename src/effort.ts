// Reasoning controls (PROTOCOL.md §3.6): a text directive in the system
// prompt, plus a structured `additionalModelRequestFields` effort when the
// model's catalog schema declares one.

import type { ThinkingLevel } from "@earendil-works/pi-ai";

const BUDGET: Record<ThinkingLevel, number> = {
  minimal: 10_000,
  low: 10_000,
  medium: 20_000,
  high: 30_000,
  xhigh: 50_000,
  max: 50_000,
};

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;

export interface EffortConfig {
  field: "reasoning" | "output_config";
  values: string[];
  summarizedThinking: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Read the effort field and its allowed values out of a model's request-fields JSON Schema. */
export function deriveEffortConfig(schema: unknown): EffortConfig | undefined {
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
  const props = schema.properties;
  for (const field of ["reasoning", "output_config"] as const) {
    const f = props[field];
    if (!isRecord(f) || !isRecord(f.properties)) continue;
    const effort = f.properties.effort;
    if (!isRecord(effort) || !Array.isArray(effort.enum)) continue;
    const values = [...new Set(effort.enum.filter((v): v is string => typeof v === "string" && v.length > 0))];
    if (values.length === 0) continue;
    const thinking = props.thinking;
    const display = isRecord(thinking) && isRecord(thinking.properties) ? thinking.properties.display : undefined;
    const summarizedThinking = isRecord(display) && Array.isArray(display.enum) && display.enum.includes("summarized");
    return { field, values, summarizedThinking };
  }
  return undefined;
}

/** Nearest allowed effort: the level itself, else the next higher, else the next lower. */
export function pickEffort(level: ThinkingLevel, values: readonly string[]): string | undefined {
  const target = level === "minimal" ? "low" : level;
  if (values.includes(target)) return target;
  const i = EFFORT_ORDER.indexOf(target);
  for (let j = i + 1; j < EFFORT_ORDER.length; j++) if (values.includes(EFFORT_ORDER[j] as string)) return EFFORT_ORDER[j];
  for (let j = i - 1; j >= 0; j--) if (values.includes(EFFORT_ORDER[j] as string)) return EFFORT_ORDER[j];
  return values[0];
}

export interface ReasoningPlan {
  /** Prefix for the system prompt, or "" when no directive is sent. */
  directive: string;
  additionalModelRequestFields?: Record<string, unknown>;
  effort?: string;
}

export function planReasoning(level: ThinkingLevel | undefined, config: EffortConfig | undefined): ReasoningPlan {
  if (!level) return { directive: "" };
  const plan: ReasoningPlan = { directive: "" };
  if (config) {
    const effort = pickEffort(level, config.values);
    if (effort) {
      plan.effort = effort;
      plan.additionalModelRequestFields =
        config.field === "reasoning"
          ? { reasoning: { effort } }
          : {
              output_config: { effort },
              thinking: { type: "adaptive", ...(config.summarizedThinking ? { display: "summarized" } : {}) },
            };
    }
  }
  if (config?.field !== "reasoning") {
    plan.directive = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${BUDGET[level]}</max_thinking_length>`;
  }
  return plan;
}
