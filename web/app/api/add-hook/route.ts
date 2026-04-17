// /api/add-hook — takes a rendered clip on the Mac mini, optionally generates
// a short engaging hook question via Gemma (based on MLX Whisper transcript of
// the first 10s), then burns the hook text into the top of the frame for the
// first N seconds using ffmpeg drawtext. This is the standard viral reels
// pattern — a bold question/title at the top while the person speaks.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const MAC_MINI = "bigneek@192.168.1.244";
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const LLM_MODEL = process.env.LLM_MODEL ?? "google/gemma-4-26b-a4b-it";

const HOOK_PROMPT = "Write a 3-8 word engaging hook question or statement for a social media reel based on this transcript. Return ONLY the text, no quotes, no markdown, no explanation. Make it punchy and curiosity-driven. Transcript: ";

function splitHookText(text: string, maxCharsPerLine = 28): string {
    // Split into at most 2 lines at a word boundary
    if (text.length <= maxCharsPerLine) return text;
    const words = text.split(/\s+/);
    let line1 = "";
    let line2 = "";
    for (const w of words) {
        if (!line2 && (line1 + " " + w).trim().length <= maxCharsPerLine) {
            line1 = (line1 + " " + w).trim();
        } else {
            line2 = (line2 + " " + w).trim();
        }
    }
    return line2 ? `${line1}\n${line2}` : line1;
}

function sanitizeHook(raw: string): string {
    let t = raw.trim();
    // Strip surrounding quotes (straight + curly)
    t = t.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "");
    // Strip leading markdown bullets / numbering
    t = t.replace(/^[\-\*\d\.\)]+\s*/, "");
    // Replace straight apostrophes with curly to avoid drawtext quoting issues
    t = t.replace(/'/g, "\u2019");
    // Collapse whitespace
    t = t.replace(/\s+/g, " ").trim();
    // Limit length
    if (t.length > 60) t = t.slice(0, 60).trim();
    return t;
}

export async function POST(req: Request) {
    let body: {
        output_file: string;
        hookText?: string | null;
        duration?: number;
        orientation?: "vertical" | "horizontal";
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    const {
        output_file,
        hookText: userHookText,
        duration = 4,
        orientation = "vertical",
    } = body;

    if (!output_file.startsWith("/tmp/") || !output_file.endsWith(".mp4")) {
        return NextResponse.json({ ok: false, error: "invalid file path" }, { status: 400 });
    }

    const hookedPath = output_file.replace(/\.mp4$/, "_hooked.mp4");
    const hookTextPath = output_file.replace(/\.mp4$/, "_hook.txt");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            function send(event: string, data: Record<string, unknown>) {
                try {
                    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                } catch {}
            }

            try {
                const { execSync } = await import("child_process");

                // ---------------------------------------------------------------
                // Step 1: Resolve hook text (user-provided OR auto-generated)
                // ---------------------------------------------------------------
                let hookText = "";

                if (userHookText && userHookText.trim().length > 0) {
                    hookText = sanitizeHook(userHookText);
                    send("status", { message: `Using provided hook: ${hookText}` });
                } else {
                    // Auto-generate: transcribe first 10s with MLX Whisper
                    send("status", { message: "Transcribing first 10s with MLX Whisper..." });

                    const transcribeScript = `
import mlx_whisper, json, sys, subprocess, os

src = sys.argv[1]
clip_path = "/tmp/_hook_first10.wav"

# Extract first 10s of audio as wav
subprocess.run([
    "/opt/homebrew/bin/ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
    "-ss", "0", "-t", "10", "-i", src,
    "-vn", "-ac", "1", "-ar", "16000", clip_path,
], check=True)

result = mlx_whisper.transcribe(
    clip_path,
    path_or_hf_repo="mlx-community/whisper-base-mlx",
)

text = " ".join(seg["text"].strip() for seg in result.get("segments", []))
text = " ".join(text.split())

try:
    os.remove(clip_path)
except Exception:
    pass

print(json.dumps({"ok": True, "text": text}))
`.trim();

                    execSync(
                        `ssh ${MAC_MINI} "cat > /tmp/_hook_transcribe.py"`,
                        { input: transcribeScript, encoding: "utf-8", timeout: 5000 },
                    );

                    const transcribeResult = execSync(
                        `ssh ${MAC_MINI} "PATH=/opt/homebrew/bin:\\$PATH /usr/bin/python3 /tmp/_hook_transcribe.py '${output_file}'"`,
                        { encoding: "utf-8", timeout: 120000 },
                    );

                    const jsonLine = transcribeResult.trim().split("\n").filter(l => l.startsWith("{")).pop();
                    if (!jsonLine) {
                        send("error", { error: "Hook transcription failed — no output" });
                        controller.close();
                        return;
                    }
                    const { text: transcript } = JSON.parse(jsonLine) as { ok: boolean; text: string };
                    send("status", { message: `Transcript: ${transcript.slice(0, 80)}...` });

                    if (!LLM_API_KEY) {
                        send("error", { error: "LLM_API_KEY not set — cannot auto-generate hook" });
                        controller.close();
                        return;
                    }

                    // Ask Gemma for a hook
                    send("status", { message: "Gemma generating hook..." });

                    const llmScript = `
import json, sys, urllib.request

base_url = sys.argv[1].rstrip("/")
api_key  = sys.argv[2]
model    = sys.argv[3]
prompt   = sys.stdin.read()

req = urllib.request.Request(
    base_url + "/chat/completions",
    method="POST",
    headers={
        "Authorization": "Bearer " + api_key,
        "Content-Type": "application/json",
    },
    data=json.dumps({
        "model": model,
        "max_tokens": 60,
        "temperature": 0.7,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8"),
)
with urllib.request.urlopen(req, timeout=30) as resp:
    payload = json.loads(resp.read().decode("utf-8"))

text = payload["choices"][0]["message"]["content"].strip()
print(json.dumps({"ok": True, "hook": text}))
`.trim();

                    execSync(
                        `ssh ${MAC_MINI} "cat > /tmp/_hook_llm.py"`,
                        { input: llmScript, encoding: "utf-8", timeout: 5000 },
                    );

                    // Pass prompt via stdin to avoid shell quoting issues
                    const fullPrompt = HOOK_PROMPT + transcript;
                    const llmResult = execSync(
                        `ssh ${MAC_MINI} "/usr/bin/python3 /tmp/_hook_llm.py '${LLM_BASE_URL}' '${LLM_API_KEY}' '${LLM_MODEL}'"`,
                        { input: fullPrompt, encoding: "utf-8", timeout: 60000 },
                    );

                    const llmJsonLine = llmResult.trim().split("\n").filter(l => l.startsWith("{")).pop();
                    if (!llmJsonLine) {
                        send("error", { error: "LLM returned no parseable output" });
                        controller.close();
                        return;
                    }
                    const { hook: rawHook } = JSON.parse(llmJsonLine) as { ok: boolean; hook: string };
                    hookText = sanitizeHook(rawHook);
                    send("status", { message: `Generated hook: ${hookText}` });
                }

                if (!hookText) {
                    send("error", { error: "Empty hook text" });
                    controller.close();
                    return;
                }

                // ---------------------------------------------------------------
                // Step 2: Write hook text to file on Mac mini (multi-line aware)
                // ---------------------------------------------------------------
                const wrapped = splitHookText(hookText, 28);

                // Write via stdin to sidestep every possible shell quoting issue
                execSync(
                    `ssh ${MAC_MINI} "cat > '${hookTextPath}'"`,
                    { input: wrapped, encoding: "utf-8", timeout: 5000 },
                );

                // ---------------------------------------------------------------
                // Step 3: Burn hook with ffmpeg drawtext
                // ---------------------------------------------------------------
                send("status", { message: "Burning hook text with ffmpeg drawtext..." });

                const isVertical = orientation !== "horizontal";
                const fontSize = isVertical ? 58 : 48;
                const yPos = isVertical ? 140 : 80;
                const lineSpacing = 12;
                const fontFile = "/System/Library/Fonts/Helvetica.ttc";

                // drawtext filter — use textfile= so we don't need to escape the text.
                // Put it inside a semi-transparent rounded box for readability.
                const drawtext = [
                    `drawtext=fontfile=${fontFile}`,
                    `textfile=${hookTextPath}`,
                    `fontsize=${fontSize}`,
                    `fontcolor=white`,
                    `borderw=5`,
                    `bordercolor=black@0.9`,
                    `box=1`,
                    `boxcolor=black@0.55`,
                    `boxborderw=28`,
                    `line_spacing=${lineSpacing}`,
                    `x=(w-text_w)/2`,
                    `y=${yPos}`,
                    `enable='between(t,0,${duration})'`,
                ].join(":");

                const ffmpegCmd =
                    `/opt/homebrew/bin/ffmpeg -hide_banner -y -i '${output_file}' ` +
                    `-vf "${drawtext}" -c:a copy '${hookedPath}'`;

                send("ffmpeg_command", { command: ffmpegCmd });

                execSync(
                    `ssh ${MAC_MINI} "${ffmpegCmd.replace(/"/g, '\\"')}"`,
                    { encoding: "utf-8", timeout: 120000 },
                );

                send("complete", {
                    output_file: hookedPath,
                    hookText,
                    wrapped,
                    duration,
                    ffmpeg_command: ffmpegCmd,
                });
            } catch (e) {
                send("error", { error: String(e).slice(0, 500) });
            }

            controller.close();
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
        },
    });
}
