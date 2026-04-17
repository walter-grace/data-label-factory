// /api/inspector-chat — sends user message + screenshot + DOM context to an
// OpenAI-compatible LLM (OpenRouter, local ollama/vllm, or any OpenAI API).
//
// Configure via .env.local:
//   LLM_BASE_URL=https://openrouter.ai/api/v1       (or http://localhost:11434/v1 for ollama)
//   LLM_API_KEY=sk-or-...                            (OpenRouter key, or empty for local)
//   LLM_MODEL=google/gemma-3-27b-it                  (or any model your provider supports)

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const LLM_MODEL = process.env.LLM_MODEL ?? "google/gemma-3-27b-it";

type ChatMessage = {
    role: "user" | "assistant" | "system";
    content: string;
};

export async function POST(req: Request) {
    let body: {
        message: string;
        screenshot_base64?: string;
        labels?: any[];
        mapped?: any[];
        all_dom?: any[];
        html_snippet?: string;
        history?: ChatMessage[];
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    const { message, screenshot_base64, labels, mapped, all_dom, html_snippet, history } = body;
    if (!message) {
        return NextResponse.json({ ok: false, error: "message required" }, { status: 400 });
    }

    // Build context text
    const contextParts: string[] = [];

    if (mapped && mapped.length > 0) {
        contextParts.push("## OmniParser Detected Elements (auto-detected interactive UI elements):");
        for (const m of mapped) {
            contextParts.push(
                `- <${m.tag}> selector="${m.selector}" confidence=${m.confidence?.toFixed?.(2) ?? "?"} ` +
                `bbox=(${m.bbox_px?.x1?.toFixed(0)},${m.bbox_px?.y1?.toFixed(0)})→(${m.bbox_px?.x2?.toFixed(0)},${m.bbox_px?.y2?.toFixed(0)})` +
                (m.styles ? ` styles={fontSize:${m.styles.fontSize},color:${m.styles.color},bg:${m.styles.backgroundColor}}` : ""),
            );
        }
    }

    if (labels && labels.length > 0) {
        contextParts.push("\n## User-Drawn Labels (manually drawn by the user on the screenshot):");
        for (const l of labels) {
            contextParts.push(
                `- "${l.name}" → <${l.match.tag}> selector="${l.match.selector}" ` +
                `text="${(l.match.text || "").slice(0, 80)}" ` +
                `bbox=(${l.match.x1?.toFixed(0)},${l.match.y1?.toFixed(0)})→(${l.match.x2?.toFixed(0)},${l.match.y2?.toFixed(0)})` +
                (l.match.styles ? ` styles={fontSize:${l.match.styles.fontSize},color:${l.match.styles.color},bg:${l.match.styles.backgroundColor}}` : ""),
            );
        }
    }

    if (all_dom && all_dom.length > 0) {
        contextParts.push("\n## All DOM Elements (use these selectors for label commands):");
        // Include most useful elements — filter out tiny ones and group by tag
        const meaningful = all_dom.filter((d: any) =>
            (d.x2 - d.x1) > 10 && (d.y2 - d.y1) > 10 &&
            !["script", "style", "meta", "link", "br", "hr"].includes(d.tag)
        ).slice(0, 150);
        for (const d of meaningful) {
            const text = d.text ? ` text="${d.text.slice(0, 60)}"` : "";
            contextParts.push(
                `- <${d.tag}> selector="${d.selector}" bbox=(${d.x1?.toFixed(0)},${d.y1?.toFixed(0)})→(${d.x2?.toFixed(0)},${d.y2?.toFixed(0)})${text}`,
            );
        }
    }

    if (html_snippet) {
        contextParts.push(`\n## Page HTML (first ${(html_snippet.length / 1024).toFixed(0)} KB):\n\`\`\`html\n${html_snippet.slice(0, 30000)}\n\`\`\``);
    }

    const systemPrompt =
        "You are Vision Inspector, an AI that helps frontend engineers understand and modify website UIs. " +
        "You can see structured data about a webpage's DOM elements, CSS styles, and user-drawn labels. " +
        "When the user asks about an element, identify it by its CSS selector and provide actionable advice " +
        "(what to change in the code). Be concise and specific — give selectors, CSS properties, and exact values.\n\n" +
        "IMPORTANT: When the user asks you to label, draw, highlight, or box an element, you MUST include one or more " +
        "label commands in your response using this exact format:\n" +
        "```label\n{\"selector\": \"the-css-selector\", \"name\": \"Label Name\"}\n```\n" +
        "You can include multiple label blocks. The selector must match one from the DOM elements provided. " +
        "The UI will automatically draw the box and save it. Always include a label block when the user says " +
        "draw, label, highlight, box, circle, mark, point to, or show me.";

    // Build OpenAI-compatible messages
    const messages: any[] = [
        { role: "system", content: systemPrompt },
    ];

    // Add history
    if (history && history.length > 0) {
        for (const h of history) {
            messages.push({ role: h.role, content: h.content });
        }
    }

    // Current user message: context + image (if vision model) + message
    // For vision models: use content array with image_url. For text-only: inline context.
    const userParts: string[] = [];
    if (contextParts.length > 0) {
        userParts.push(contextParts.join("\n"));
    }
    userParts.push(message);

    // Try vision format first (works with OpenRouter vision models, GPT-4o, etc.)
    // Falls back gracefully if model doesn't support images.
    if (screenshot_base64) {
        messages.push({
            role: "user",
            content: [
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/png;base64,${screenshot_base64}`,
                    },
                },
                {
                    type: "text",
                    text: userParts.join("\n\n"),
                },
            ],
        });
    } else {
        messages.push({
            role: "user",
            content: userParts.join("\n\n"),
        });
    }

    try {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };
        if (LLM_API_KEY) {
            headers["Authorization"] = `Bearer ${LLM_API_KEY}`;
        }
        // OpenRouter-specific headers (ignored by other providers)
        headers["HTTP-Referer"] = "https://github.com/walter-grace/mac-code";
        headers["X-Title"] = "Vision Inspector";

        const r = await fetch(`${LLM_BASE_URL}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: LLM_MODEL,
                messages,
                max_tokens: 1024,
                temperature: 0.3,
            }),
        });

        if (!r.ok) {
            const errText = await r.text();
            return NextResponse.json(
                { ok: false, error: `LLM API ${r.status}: ${errText.slice(0, 300)}` },
                { status: 502 },
            );
        }

        const data = await r.json();
        const reply = data.choices?.[0]?.message?.content ?? "(no response)";

        return NextResponse.json({
            ok: true,
            reply,
            model: data.model ?? LLM_MODEL,
        });
    } catch (e) {
        return NextResponse.json(
            { ok: false, error: `LLM API error: ${String(e)}` },
            { status: 502 },
        );
    }
}
