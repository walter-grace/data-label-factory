// /api/transcribe — run MLX Whisper on a clip that already lives on the
// Mac mini and return word-level segments as JSON. The /crop-v2 page uses
// this to drive its live caption preview.
//
// Unlike /api/add-subtitles, this route does NOT re-encode the video — it
// just transcribes and returns the segment list. We keep a tiny in-memory
// cache keyed by file path so flipping the captions toggle on/off doesn't
// re-run Whisper for the same clip.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const MAC_MINI = "bigneek@192.168.1.244";

type TranscriptWord = { word: string; start: number; end: number };
type TranscriptSegment = {
    start: number;
    end: number;
    text: string;
    words: TranscriptWord[];
};

// Module-level cache survives between hot-reloaded requests but not
// process restarts. That is fine — the frontend also caches in state.
const g = globalThis as unknown as {
    __transcribeCache?: Map<string, TranscriptSegment[]>;
};
if (!g.__transcribeCache) g.__transcribeCache = new Map();
const cache = g.__transcribeCache;

export async function POST(req: Request) {
    let body: { output_file: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json(
            { ok: false, error: "invalid json" },
            { status: 400 },
        );
    }

    const outputFile = body.output_file;
    if (!outputFile || typeof outputFile !== "string") {
        return NextResponse.json(
            { ok: false, error: "output_file required" },
            { status: 400 },
        );
    }
    if (!outputFile.startsWith("/tmp/")) {
        return NextResponse.json(
            { ok: false, error: "invalid file path" },
            { status: 400 },
        );
    }

    // Cache hit?
    const cached = cache.get(outputFile);
    if (cached) {
        return NextResponse.json({ ok: true, segments: cached, cached: true });
    }

    try {
        const { execSync } = await import("child_process");

        const transcribeScript = `
import sys, json, mlx_whisper

result = mlx_whisper.transcribe(
    sys.argv[1],
    path_or_hf_repo="mlx-community/whisper-base-mlx",
    word_timestamps=True,
)
segs = []
for seg in result.get("segments", []):
    segs.append({
        "start": seg["start"],
        "end": seg["end"],
        "text": seg["text"].strip(),
        "words": [
            {"word": w["word"], "start": w["start"], "end": w["end"]}
            for w in seg.get("words", [])
        ],
    })
print(json.dumps({"ok": True, "segments": segs}))
`.trim();

        execSync(`ssh ${MAC_MINI} "cat > /tmp/_transcribe_words.py"`, {
            input: transcribeScript,
            encoding: "utf-8",
            timeout: 5000,
        });

        const raw = execSync(
            `ssh ${MAC_MINI} "PATH=/opt/homebrew/bin:\\$PATH /usr/bin/python3 /tmp/_transcribe_words.py '${outputFile}'"`,
            { encoding: "utf-8", timeout: 150000, maxBuffer: 20 * 1024 * 1024 },
        );

        // The last JSON line is our payload (whisper can emit progress to stderr
        // which we don't capture, but grab only the JSON-looking tail just in case).
        const jsonLine = raw
            .trim()
            .split("\n")
            .filter((l) => l.trim().startsWith("{"))
            .pop();
        if (!jsonLine) {
            return NextResponse.json(
                { ok: false, error: "no transcript output" },
                { status: 500 },
            );
        }
        const parsed = JSON.parse(jsonLine) as {
            ok: boolean;
            segments: TranscriptSegment[];
        };
        if (!parsed.ok) {
            return NextResponse.json(
                { ok: false, error: "transcription failed" },
                { status: 500 },
            );
        }

        cache.set(outputFile, parsed.segments);

        return NextResponse.json({
            ok: true,
            segments: parsed.segments,
            cached: false,
        });
    } catch (e) {
        return NextResponse.json(
            { ok: false, error: String(e).slice(0, 500) },
            { status: 500 },
        );
    }
}
