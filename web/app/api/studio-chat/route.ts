import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Message = { role: "user" | "assistant"; content: string };
type Scene = Record<string, unknown>;

type OpenRouterTool = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

const TOOLS: OpenRouterTool[] = [
    {
        type: "function",
        function: {
            name: "add_clip",
            description: "Append a clip from the library to the end of the timeline.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Source path on Mac mini e.g. /tmp/viral_clip_1.mp4" },
                    in: { type: "number", description: "Optional in-point in seconds" },
                    out: { type: "number", description: "Optional out-point in seconds" },
                },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "remove_clip",
            description: "Remove a clip by id.",
            parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "trim_clip",
            description: "Set the in/out points of an existing clip.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    in: { type: "number" },
                    out: { type: "number" },
                },
                required: ["id", "in", "out"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "reorder_clip",
            description: "Move a clip to a new index in the timeline.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    newIndex: { type: "number" },
                },
                required: ["id", "newIndex"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "add_text",
            description: "Add a text overlay to the timeline.",
            parameters: {
                type: "object",
                properties: {
                    content: { type: "string" },
                    start: { type: "number" },
                    end: { type: "number" },
                    style: { type: "string", enum: ["default", "title", "caption", "hook"] },
                },
                required: ["content", "start", "end"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "add_audio",
            description: "Add an audio track to the timeline.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    start: { type: "number" },
                    end: { type: "number" },
                    volume: { type: "number" },
                },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "edit_text",
            description: "Edit an existing text overlay's content, timing, style, or animation.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    content: { type: "string" },
                    start: { type: "number" },
                    end: { type: "number" },
                    style: { type: "string", enum: ["default", "title", "caption", "hook"] },
                    animation: {
                        type: "string",
                        enum: ["none", "fade", "slide-up", "pop", "typewriter", "word-pop", "word-highlight"],
                    },
                },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "set_transition",
            description:
                "Set the entry transition for a clip (how it enters from the previous clip). First clip must be 'cut'.",
            parameters: {
                type: "object",
                properties: {
                    clip_id: { type: "string" },
                    kind: {
                        type: "string",
                        enum: ["cut", "fade", "crossfade", "slide-left", "slide-right"],
                    },
                    duration: { type: "number", description: "Transition duration in seconds (default 0.5)" },
                },
                required: ["clip_id", "kind"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "auto_caption",
            description:
                "Run Whisper auto-transcription on the first clip and append word-pop caption phrases to the scene.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "set_orientation",
            description: "Set the export orientation.",
            parameters: {
                type: "object",
                properties: {
                    orientation: { type: "string", enum: ["vertical", "horizontal"] },
                },
                required: ["orientation"],
            },
        },
    },
];

const MODEL = process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || "google/gemma-4-26b-a4b-it";
const BASE_URL = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";

// NOTE: this function body is what later ships to a Dynamic Worker sandbox.
// The shape is intentionally pure: (messages, scene) -> { reply, operations }.
async function runChat(messages: Message[], scene: Scene) {
    const key = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
    if (!key) {
        console.log("[studio-chat] no OPENROUTER_API_KEY / LLM_API_KEY — returning stub");
        return {
            reply:
                "(stub) No OPENROUTER_API_KEY / LLM_API_KEY set. I would edit the scene here. " +
                `Current scene has ${(scene as { clips?: unknown[] }).clips?.length ?? 0} clips.`,
            operations: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
        };
    }

    const sceneJson = JSON.stringify(scene, null, 2).slice(0, 4000);
    const system =
        "You are the editor agent for a CapCut-style video studio. " +
        "The user gives natural-language instructions; you respond by calling one or more tools that mutate the scene graph. " +
        "Always call tools to make edits — don't just describe them. After tool calls, give a one-sentence confirmation. " +
        "Available clip library paths: /tmp/viral_clip_1.mp4, /tmp/viral_clip_2.mp4, /tmp/viral_clip_2_demo_render.mp4, /tmp/viral_clip_2_demo_render_sub.mp4, /tmp/viral_clip_1_sub.mp4. " +
        "Text styles: default, title, caption, hook. Text animations: none, fade, slide-up, pop, typewriter, word-pop, word-highlight. " +
        "word-highlight renders multi-word subtitles in blue with the current word highlighted in green — use it when the user asks for highlighted captions, karaoke, or blue-and-green subtitles. " +
        "Clip transitions: cut, fade, crossfade, slide-left, slide-right. " +
        "Orientations: vertical, horizontal. " +
        `Current scene:\n${sceneJson}`;

    const openRouterMessages = [
        { role: "system", content: system },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const resp = await fetch(`${BASE_URL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
            "HTTP-Referer": "http://localhost:3030/studio",
            "X-Title": "Crop Studio",
        },
        body: JSON.stringify({
            model: MODEL,
            messages: openRouterMessages,
            tools: TOOLS,
            tool_choice: "auto",
            reasoning: { enabled: true },
            max_tokens: 1024,
        }),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`openrouter ${resp.status}: ${text.slice(0, 300)}`);
    }

    const data = (await resp.json()) as {
        choices?: Array<{
            message?: {
                content?: string | null;
                tool_calls?: Array<{
                    id: string;
                    type: "function";
                    function: { name: string; arguments: string };
                }>;
            };
        }>;
    };

    const msg = data.choices?.[0]?.message ?? {};
    const operations: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    for (const call of msg.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
            args = JSON.parse(call.function.arguments || "{}");
        } catch {
            args = { _raw: call.function.arguments };
        }
        operations.push({ name: call.function.name, arguments: args });
    }

    let replyText = (msg.content ?? "").trim();
    if (!replyText) {
        replyText = operations.length > 0 ? `Applied ${operations.length} operation(s).` : "(no reply)";
    }

    return { reply: replyText, operations };
}

export async function POST(req: Request) {
    let body: { messages: Message[]; scene: Scene };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ reply: "invalid json", operations: [] }, { status: 400 });
    }

    try {
        const result = await runChat(body.messages ?? [], body.scene ?? {});
        return NextResponse.json(result);
    } catch (e) {
        const err = e as Error;
        console.error("[studio-chat] error:", err);
        return NextResponse.json(
            { reply: `error: ${err.message ?? String(e)}`.slice(0, 500), operations: [] },
            { status: 500 },
        );
    }
}
