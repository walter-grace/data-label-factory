import { NextRequest } from "next/server";

/**
 * POST /api/chat — Conversational agent backed by OpenRouter + DLF tool calls.
 *
 * Body: { messages: [{role, content}], user_id? }
 * Response: SSE stream of {type: "text"|"tool_call"|"tool_result"|"done", ...}
 *
 * The agent can call DLF backend tools to answer questions:
 *   - list_templates     → show marketplace options
 *   - parse_document     → parse a URL or uploaded file
 *   - extract_fields     → apply a template to a doc
 *   - doc_challenges     → list flywheel challenges
 *   - providers          → list available backends
 *   - benchmark          → show Roboflow accuracy numbers
 *
 * Tool calls go to the local DLF backend at DLF_API_URL.
 */

const DLF_API = process.env.DLF_API_URL || "http://localhost:8400";
const LLM_BASE = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
const LLM_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "google/gemma-4-26b-a4b-it";

const SYSTEM_PROMPT = `You are the Data Label Factory assistant — a helpful guide for a document extraction and vision-labeling platform.

What you can help with:
- **Parse documents**: Users drop PDFs, DOCX, XLSX, images → LiteParse extracts layout-preserving text + bboxes
- **Template extraction**: Users label one document, save a template, apply it to thousands. Templates define named fields (invoice_number, total, line_items) at specific bbox positions.
- **Template marketplace**: 5 pre-built templates (us-invoice, w2, 1099-nec, receipt, service-agreement) ready to use.
- **Flywheel game**: Gamified labeling where humans and agents verify document blocks (is this a header? YES/NO). Builds training data via GRPO rewards.
- **Agent integration**: MCP tools + REST API let AI agents register, play Flywheel, extract documents, connect Moltbook identity.
- **Cluster intake**: Upload mixed docs → auto-cluster by layout similarity → pick a cluster to template.

You have tools to query the platform in real-time. Use them when the user asks about available templates, backend status, or benchmark numbers.

Be concise and actionable. Guide users to the right page:
- /parse → try parsing a single doc
- /template/library → browse pre-built templates
- /template/new → create a custom template
- /template/intake → cluster + template mixed docs
- /play/docs → play the document Flywheel game
- /extract → product overview with benchmark numbers
- /connect → register an agent or connect Moltbook

When a user describes what they want to extract, suggest the closest marketplace template first, then offer to help customize it.`;

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_templates",
      description: "List all document extraction templates in the marketplace (library) and user-saved.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_template",
      description: "Get full details of a specific template by name (fields, bboxes, types).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Template slug, e.g. 'us-invoice'" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_providers",
      description: "List all registered labeling providers and their status (alive/down).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_benchmark",
      description: "Get the Roboflow Invoice-NER benchmark results (word precision, detection rates, parse time).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_doc_challenges",
      description: "List available document-labeling challenges for the Flywheel game.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_rewards_stats",
      description: "Get GRPO reward pool statistics (total labels, doc labels, human vs agent, readiness).",
      parameters: { type: "object", properties: {} },
    },
  },
];

async function executeTool(name: string, args: any): Promise<string> {
  try {
    let url: string;
    let method = "GET";

    switch (name) {
      case "list_templates":
        url = `${DLF_API}/api/templates?library=true`;
        break;
      case "get_template":
        url = `${DLF_API}/api/template/${encodeURIComponent(args.name)}?library=true`;
        break;
      case "list_providers":
        url = `${DLF_API}/api/providers`;
        break;
      case "get_benchmark":
        url = `${DLF_API}/api/benchmark/roboflow`;
        break;
      case "list_doc_challenges":
        url = `${DLF_API}/api/doc-challenges?limit=10`;
        break;
      case "get_rewards_stats":
        // This one hits Next.js directly (reward pool is in-memory there)
        url = `http://localhost:3030/api/rewards?stats`;
        break;
      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }

    const r = await fetch(url, { method, cache: "no-store" });
    const data = await r.json();
    // Truncate large responses to keep context manageable
    const str = JSON.stringify(data);
    return str.length > 3000 ? str.slice(0, 3000) + "...(truncated)" : str;
  } catch (e: any) {
    return JSON.stringify({ error: e.message });
  }
}

export async function POST(req: NextRequest) {
  if (!LLM_KEY) {
    return new Response(
      JSON.stringify({ error: "LLM_API_KEY not configured" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400 });
  }

  const userMessages = body.messages || [];
  if (userMessages.length === 0) {
    return new Response(JSON.stringify({ error: "messages array required" }), { status: 400 });
  }

  // Build the full conversation with system prompt
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...userMessages,
  ];

  // SSE stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // First LLM call — may produce tool calls
        let llmMessages = [...messages];
        let maxRounds = 3; // prevent infinite tool-call loops

        for (let round = 0; round < maxRounds; round++) {
          const llmRes = await fetch(`${LLM_BASE}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${LLM_KEY}`,
            },
            body: JSON.stringify({
              model: LLM_MODEL,
              messages: llmMessages,
              tools: TOOLS,
              tool_choice: "auto",
              max_tokens: 2048,
            }),
          });

          if (!llmRes.ok) {
            const err = await llmRes.text();
            send({ type: "error", error: `LLM error ${llmRes.status}: ${err.slice(0, 200)}` });
            break;
          }

          const llmData = await llmRes.json();
          const choice = llmData.choices?.[0];
          if (!choice) {
            send({ type: "error", error: "no choices in LLM response" });
            break;
          }

          const msg = choice.message;

          // If there's text content, stream it
          if (msg.content) {
            send({ type: "text", content: msg.content });
          }

          // If there are tool calls, execute them
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            llmMessages.push(msg); // add assistant msg with tool_calls

            for (const tc of msg.tool_calls) {
              send({
                type: "tool_call",
                tool: tc.function.name,
                args: tc.function.arguments,
              });

              const args = typeof tc.function.arguments === "string"
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments;

              const result = await executeTool(tc.function.name, args);

              send({
                type: "tool_result",
                tool: tc.function.name,
                result: result.length > 500 ? result.slice(0, 500) + "..." : result,
              });

              llmMessages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: result,
              });
            }

            // Continue loop — LLM will process tool results
            continue;
          }

          // No tool calls, we're done
          break;
        }

        send({ type: "done" });
      } catch (e: any) {
        send({ type: "error", error: e.message });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
