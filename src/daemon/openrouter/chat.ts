/**
 * Live OpenRouter chat client — the `Chat` that `runAgentLoop` runs on (PRD §10, design §16).
 *
 * The request/response MAPPERS between our {@link Message}/{@link ToolDef} shapes and OpenAI-style
 * chat-completions JSON (and the response → {@link ChatResponse}) are pure + unit-tested. The fetch is the
 * thin live part (needs an API key). Non-streaming, tool_choice="auto"; usage cost read when the provider
 * returns it.
 */

import type { Chat, ChatResponse, Message, ToolCall, ToolDef } from "./runner.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Our ToolDefs → OpenAI function-tool JSON. */
export function toOpenAITools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } },
  }));
}

/** Our transcript → OpenAI messages (assistant tool_calls carry JSON-string arguments; tool msgs carry the id). */
export function toOpenAIMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
      };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    return { role: m.role, content: m.content };
  });
}

function safeArgs(raw: unknown): Record<string, any> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

/** OpenAI-style completion JSON → ChatResponse (text + tool calls + cost, all tolerant of a shapeless body). */
export function parseChatCompletion(json: unknown): ChatResponse {
  const msg = (json as any)?.choices?.[0]?.message;
  const toolCalls: ToolCall[] = ((msg?.tool_calls as any[]) ?? [])
    .map((tc) => ({ id: String(tc?.id ?? ""), name: String(tc?.function?.name ?? ""), args: safeArgs(tc?.function?.arguments) }))
    .filter((c) => c.name);
  const cost = (json as any)?.usage?.cost;
  return {
    text: typeof msg?.content === "string" ? msg.content : undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    usageCost: typeof cost === "number" ? cost : undefined,
  };
}

/** Live `Chat` bound to an OpenRouter key + model. Throws on a non-2xx (the loop renders it + stops). */
export function httpOpenRouterChat(apiKey: string, model: string, endpoint = OPENROUTER_URL): Chat {
  return async (messages, tools) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
        tool_choice: "auto",
        usage: { include: true },
      }),
    });
    if (!res.ok) throw new Error(`openrouter: HTTP ${res.status} ${res.statusText}`);
    return parseChatCompletion(await res.json());
  };
}
