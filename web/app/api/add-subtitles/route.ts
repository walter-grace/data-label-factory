// /api/add-subtitles — takes a rendered clip on the Mac mini,
// transcribes it with MLX Whisper, generates chunked SRT,
// burns subtitles into the video, and returns the path.

import { NextResponse } from "next/server";

import {
    CAPTION_PRESETS,
    captionStyleToForceStyle,
    type CaptionStyle,
} from "@/app/crop-v2/lib/captions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const MAC_MINI = "bigneek@192.168.1.244";

export async function POST(req: Request) {
    let body: {
        output_file: string;
        style?: "word" | "chunk" | "full" | "smart";
        frameWidth?: number;
        captionStyle?: CaptionStyle;
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    const { output_file, style = "chunk", frameWidth, captionStyle } = body;

    if (!output_file.startsWith("/tmp/")) {
        return NextResponse.json({ ok: false, error: "invalid file path" }, { status: 400 });
    }

    const srtPath = output_file.replace(/\.mp4$/, ".srt");
    const subbedPath = output_file.replace(/\.mp4$/, "_sub.mp4");

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

                // Step 1: Write the transcription script to the Mac mini
                send("status", { message: "Transcribing with MLX Whisper..." });

                const transcribeScript = `
import mlx_whisper, json, sys

result = mlx_whisper.transcribe(
    sys.argv[1],
    path_or_hf_repo="mlx-community/whisper-base-mlx",
    word_timestamps=True,
)

def fmt(t):
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

srt_lines = []
idx = 1
for seg in result.get("segments", []):
    srt_lines.append(str(idx))
    start_ts = fmt(seg["start"])
    end_ts = fmt(seg["end"])
    srt_lines.append(start_ts + " --> " + end_ts)
    srt_lines.append(seg["text"].strip())
    srt_lines.append("")
    idx += 1

srt_text = "\\n".join(srt_lines)
out_path = sys.argv[2]
with open(out_path, "w") as f:
    f.write(srt_text)

# Also dump word-level segments JSON for smart style
if len(sys.argv) > 3:
    segs_out = []
    for seg in result.get("segments", []):
        segs_out.append({
            "start": seg["start"],
            "end": seg["end"],
            "text": seg["text"],
            "words": [{"word": w["word"], "start": w["start"], "end": w["end"]} for w in seg.get("words", [])]
        })
    with open(sys.argv[3], "w") as f:
        json.dump(segs_out, f)

print(json.dumps({"ok": True, "segments": len(result.get("segments", []))}))
`.trim();

                // Write script to Mac mini
                execSync(
                    `ssh ${MAC_MINI} "cat > /tmp/_transcribe.py"`,
                    { input: transcribeScript, encoding: "utf-8", timeout: 5000 },
                );

                // Detect frame width if smart style and not provided
                let detectedWidth = frameWidth;
                if (style === "smart" && !detectedWidth) {
                    try {
                        const w = execSync(
                            `ssh ${MAC_MINI} "/opt/homebrew/bin/ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 '${output_file}'"`,
                            { encoding: "utf-8", timeout: 10000 },
                        ).trim();
                        detectedWidth = parseInt(w, 10) || 1080;
                    } catch {
                        detectedWidth = 1080;
                    }
                }

                // Run transcription (pass segments JSON path as 3rd arg for smart style)
                const segmentsJsonPath = output_file.replace(/\.mp4$/, "_segments.json");
                const extraArg = style === "smart" ? ` '${segmentsJsonPath}'` : "";
                const transcribeResult = execSync(
                    `ssh ${MAC_MINI} "PATH=/opt/homebrew/bin:\\$PATH /usr/bin/python3 /tmp/_transcribe.py '${output_file}' '${srtPath}'${extraArg}"`,
                    { encoding: "utf-8", timeout: 120000 },
                );

                const jsonLine = transcribeResult.trim().split("\n").filter(l => l.startsWith("{")).pop();
                if (!jsonLine) {
                    send("error", { error: "Transcription failed — no output" });
                    controller.close();
                    return;
                }
                const transcribeInfo = JSON.parse(jsonLine);
                send("status", { message: `Transcribed ${transcribeInfo.segments} segments` });

                // Step 2a: Smart subtitles use the new smart_srt.py module
                if (style === "smart") {
                    send("status", { message: `Generating smart subtitles (width=${detectedWidth})...` });
                    const smartScript = `
import sys, json
sys.path.insert(0, "/Users/bigneek/Desktop/ffmpeg-mpc")
from ffmpeg_mcp_duplicate.smart_srt import smart_srt_from_whisper_words

with open(sys.argv[1]) as f:
    segments = json.load(f)

srt = smart_srt_from_whisper_words(segments, frame_width=int(sys.argv[2]), font_size=16)
with open(sys.argv[3], "w") as f:
    f.write(srt)
print("OK")
`.trim();
                    execSync(
                        `ssh ${MAC_MINI} "cat > /tmp/_smart_srt.py"`,
                        { input: smartScript, encoding: "utf-8", timeout: 5000 },
                    );
                    execSync(
                        `ssh ${MAC_MINI} "/usr/bin/python3 /tmp/_smart_srt.py '${segmentsJsonPath}' ${detectedWidth} '${srtPath}'"`,
                        { encoding: "utf-8", timeout: 15000 },
                    );
                }

                // Step 2b: Convert to chunked or word-by-word SRT
                if (style === "word" || style === "chunk") {
                    send("status", { message: `Converting to ${style} subtitles...` });
                    const convertFn = style === "word" ? "srt_to_one_word_srt" : "srt_to_chunked_srt";
                    const extraArg = style === "chunk" ? ", max_words_per_chunk=4" : "";

                    const convertScript = `
import sys
sys.path.insert(0, "/Users/bigneek/Desktop/ffmpeg-mpc")
from ffmpeg_mcp_duplicate.one_word_srt import ${convertFn}

with open(sys.argv[1]) as f:
    srt_text = f.read()

converted = ${convertFn}(srt_text${extraArg})
with open(sys.argv[1], "w") as f:
    f.write(converted)

print("OK")
`.trim();

                    execSync(
                        `ssh ${MAC_MINI} "cat > /tmp/_convert_srt.py"`,
                        { input: convertScript, encoding: "utf-8", timeout: 5000 },
                    );
                    execSync(
                        `ssh ${MAC_MINI} "/usr/bin/python3 /tmp/_convert_srt.py '${srtPath}'"`,
                        { encoding: "utf-8", timeout: 10000 },
                    );
                }

                // Step 3: Burn subtitles with ffmpeg
                send("status", { message: "Burning subtitles into video..." });

                // Detect frame height for MarginV / FontSize scaling.
                let detectedHeight = 1920;
                try {
                    const h = execSync(
                        `ssh ${MAC_MINI} "/opt/homebrew/bin/ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 '${output_file}'"`,
                        { encoding: "utf-8", timeout: 10000 },
                    ).trim();
                    detectedHeight = parseInt(h, 10) || 1920;
                } catch {
                    detectedHeight = 1920;
                }

                // Default to the improved Classic preset (big Impact + thick outline)
                // when no custom captionStyle is supplied (the feature-rail button path).
                const effectiveStyle: CaptionStyle = captionStyle ?? CAPTION_PRESETS.classic;

                // ASS has no text-transform. If the style says uppercase,
                // rewrite the SRT file so the cues themselves are UPPERCASE.
                if (effectiveStyle.uppercase) {
                    execSync(
                        `ssh ${MAC_MINI} "/usr/bin/python3 -c \\"
import re, sys
p = '${srtPath}'
with open(p) as f: txt = f.read()
# Uppercase any line that isn't a cue index or a timestamp.
out = []
for line in txt.splitlines():
    if re.match(r'^\\d+$', line.strip()) or '-->' in line or not line.strip():
        out.append(line)
    else:
        out.append(line.upper())
with open(p, 'w') as f: f.write('\\n'.join(out))
\\""`,
                        { encoding: "utf-8", timeout: 5000 },
                    );
                }

                const forceStyle = captionStyleToForceStyle(effectiveStyle, detectedHeight);
                execSync(
                    `ssh ${MAC_MINI} "/opt/homebrew/bin/ffmpeg -hide_banner -y -i '${output_file}' -vf \\"subtitles='${srtPath}':force_style='${forceStyle}'\\" -c:a copy '${subbedPath}'"`,
                    { encoding: "utf-8", timeout: 120000 },
                );

                send("complete", {
                    subbed_file: subbedPath,
                    segments: transcribeInfo.segments,
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
