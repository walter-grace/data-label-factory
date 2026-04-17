// /api/remove-fillers — takes a rendered clip on the Mac mini, transcribes
// it with MLX Whisper (word timestamps), removes filler words and long
// silences via an ffmpeg concat-filter splice, and returns the tightened path.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

const MAC_MINI = "bigneek@192.168.1.244";
const DEFAULT_FILLERS = ["um", "uh", "like", "you know", "sort of", "kind of"];

export async function POST(req: Request) {
    let body: {
        output_file: string;
        fillers?: string[];
        maxSilence?: number;
        padding?: number;
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    const { output_file } = body;
    const fillers = body.fillers && body.fillers.length > 0 ? body.fillers : DEFAULT_FILLERS;
    const maxSilence = typeof body.maxSilence === "number" ? body.maxSilence : 0.8;
    const padding = typeof body.padding === "number" ? body.padding : 0.1;

    if (!output_file || !output_file.startsWith("/tmp/")) {
        return NextResponse.json({ ok: false, error: "invalid file path" }, { status: 400 });
    }

    const tightPath = output_file.replace(/\.mp4$/, "_tight.mp4");

    // Sanitize fillers — strip anything that could break shell quoting.
    const safeFillers = fillers
        .map(f => String(f).replace(/[^a-zA-Z0-9 '\u2019]/g, "").trim())
        .filter(f => f.length > 0);
    const fillerArg = safeFillers.join(",");

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

                send("status", { message: "Transcribing and analyzing fillers with MLX Whisper..." });

                const cmd =
                    `ssh ${MAC_MINI} "PATH=/opt/homebrew/bin:\\$PATH /usr/bin/python3 ` +
                    `/Users/bigneek/Desktop/ffmpeg-mpc/ffmpeg_mcp_duplicate/filler_cutter.py ` +
                    `'${output_file}' '${tightPath}' ` +
                    `--fillers '${fillerArg}' ` +
                    `--max-silence ${maxSilence} ` +
                    `--padding ${padding} 2>&1"`;

                let raw = "";
                try {
                    raw = execSync(cmd, { encoding: "utf-8", timeout: 220000, maxBuffer: 16 * 1024 * 1024 });
                } catch (err: unknown) {
                    const e = err as { stdout?: string; stderr?: string; message?: string };
                    raw = (e.stdout || "") + (e.stderr || "") + (e.message || "");
                }

                // Find the JSON payload (the last line that is a JSON object).
                const jsonLine = raw
                    .split("\n")
                    .map(l => l.trim())
                    .filter(l => l.startsWith("{") && l.endsWith("}"))
                    .pop();

                if (!jsonLine) {
                    send("error", { error: "filler_cutter produced no JSON output", raw: raw.slice(-1500) });
                    controller.close();
                    return;
                }

                let info: {
                    ok: boolean;
                    output_file?: string;
                    original_duration?: number;
                    new_duration?: number;
                    cuts?: number;
                    removed_words?: string[];
                    removed_count?: number;
                    filter_excerpt?: string;
                    total_words?: number;
                    error?: string;
                };
                try {
                    info = JSON.parse(jsonLine);
                } catch {
                    send("error", { error: "could not parse filler_cutter JSON", raw: jsonLine });
                    controller.close();
                    return;
                }

                if (!info.ok) {
                    send("error", { error: info.error || "filler_cutter failed" });
                    controller.close();
                    return;
                }

                const orig = info.original_duration ?? 0;
                const next = info.new_duration ?? 0;
                send("status", {
                    message:
                        `Removed ${info.removed_count ?? 0} filler word(s); ` +
                        `${orig.toFixed(2)}s → ${next.toFixed(2)}s ` +
                        `(saved ${(orig - next).toFixed(2)}s across ${info.cuts ?? 0} segment(s))`,
                });

                send("complete", {
                    output_file: info.output_file ?? tightPath,
                    original_duration: orig,
                    new_duration: next,
                    cuts: info.cuts ?? 0,
                    removed_words: info.removed_words ?? [],
                    removed_count: info.removed_count ?? 0,
                    total_words: info.total_words ?? 0,
                    filter_excerpt: info.filter_excerpt ?? "",
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
