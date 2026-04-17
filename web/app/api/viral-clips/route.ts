// /api/viral-clips — given a crop plan (from /api/smart-crop), asks Gemma to
// pick the most viral moments, generates per-clip ffmpeg commands, and
// optionally builds speaker highlight reels.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAC_MINI = "bigneek@192.168.1.244";
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const LLM_MODEL = process.env.LLM_MODEL ?? "google/gemma-4-26b-a4b-it";

export async function POST(req: Request) {
    let body: {
        videoPath: string;
        speakers: any[];
        segments: any[];
        duration: number;
        sourceWidth: number;
        sourceHeight: number;
        numClips?: number;
        clipLength?: number;
        speakerHighlights?: boolean;
        render?: boolean;
        orientation?: "vertical" | "horizontal";
        speakerFilter?: string; // e.g. "Speaker A" — only generate clips for this speaker
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    const {
        videoPath, speakers, segments, duration,
        sourceWidth, sourceHeight,
        numClips = 5, clipLength = 30,
        speakerHighlights = true, render = false,
        orientation = "vertical",
        speakerFilter,
    } = body;

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

                // Speaker reel mode — skip transcript + LLM, go straight to segment merging
                if (speakerFilter) {
                    send("status", { step: "picking", message: `Building ${speakerFilter} reel from tracking data...` });
                }

                // Step 1: Extract transcript (try embedded subs first, then whisper)
                if (!speakerFilter) send("status", { step: "transcribing", message: "Extracting transcript..." });

                let transcript: any[] = [];
                let viralMoments: any[] = [];

                if (!speakerFilter) {
                    // Full pipeline: transcript → LLM moment selection
                    try {
                        const transcriptResult = execSync(
                            `ssh ${MAC_MINI} "cd ~/Desktop/ffmpeg-mpc && python3 -c \\"
import json
from ffmpeg_mcp_duplicate.viral_shorts import transcribe_with_ffmpeg_subs
segs = transcribe_with_ffmpeg_subs('/opt/homebrew/bin/ffmpeg', '${videoPath}')
print(json.dumps(segs))
\\""`,
                            { encoding: "utf-8", timeout: 30000 },
                        );
                        const jsonLine = transcriptResult.trim().split("\n").filter(l => l.startsWith("[")).pop();
                        if (jsonLine) transcript = JSON.parse(jsonLine);
                    } catch {}

                    if (transcript.length === 0) {
                        send("status", { step: "transcribing", message: "No embedded subs — trying Whisper..." });
                        try {
                            const whisperResult = execSync(
                                `ssh ${MAC_MINI} "cd ~/Desktop/ffmpeg-mpc && python3 -c \\"
import json
from ffmpeg_mcp_duplicate.viral_shorts import extract_audio, transcribe_with_whisper
extract_audio('/opt/homebrew/bin/ffmpeg', '${videoPath}', '/tmp/smartcrop_audio.wav')
segs = transcribe_with_whisper('/tmp/smartcrop_audio.wav', 'base')
print(json.dumps(segs))
\\""`,
                                { encoding: "utf-8", timeout: 300000 },
                            );
                            const jsonLine = whisperResult.trim().split("\n").filter(l => l.startsWith("[")).pop();
                            if (jsonLine) transcript = JSON.parse(jsonLine);
                        } catch (e) {
                            send("status", { step: "transcribing", message: `Whisper unavailable — using speaker tracking only` });
                        }
                    }

                    send("transcript", {
                        segments: transcript.length,
                        preview: transcript.slice(0, 5).map((s: any) => `[${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, "0")}] ${s.text}`).join("\n"),
                    });

                    // Step 2: Ask Gemma to pick viral moments
                    send("status", { step: "picking", message: "Gemma picking viral moments..." });

                    if (LLM_API_KEY && transcript.length > 0) {
                        try {
                            const pickResult = execSync(
                                `ssh ${MAC_MINI} "cd ~/Desktop/ffmpeg-mpc && python3 -c \\"
import json
from ffmpeg_mcp_duplicate.viral_shorts import pick_viral_moments_with_llm
moments = pick_viral_moments_with_llm(
    json.loads('''${JSON.stringify(transcript).replace(/'/g, "\\'")}'''),
    json.loads('''${JSON.stringify(speakers).replace(/'/g, "\\'")}'''),
    ${duration},
    api_key='${LLM_API_KEY}',
    base_url='${LLM_BASE_URL}',
    model='${LLM_MODEL}',
    num_clips=${numClips},
    clip_length=${clipLength},
)
print(json.dumps(moments))
\\""`,
                                { encoding: "utf-8", timeout: 60000 },
                            );
                            const jsonLine = pickResult.trim().split("\n").filter(l => l.startsWith("[")).pop();
                            if (jsonLine) viralMoments = JSON.parse(jsonLine);
                        } catch (e) {
                            send("status", { step: "picking", message: `Gemma moment selection failed — using audio energy fallback` });
                        }
                    }
                }

                // Speaker reel mode: build clips from that speaker's segments
                if (speakerFilter && viralMoments.length === 0) {
                    send("status", { step: "picking", message: `Building ${speakerFilter} reel...` });
                    const speakerSegs = segments.filter((s: any) => s.focus === speakerFilter);
                    // Merge adjacent segments into longer chunks
                    const merged: { t_start: number; t_end: number }[] = [];
                    for (const seg of speakerSegs) {
                        if (merged.length > 0 && seg.t_start - merged[merged.length - 1].t_end < 2.0) {
                            merged[merged.length - 1].t_end = seg.t_end;
                        } else {
                            merged.push({ t_start: seg.t_start, t_end: seg.t_end });
                        }
                    }
                    // Keep chunks >= 3s, sort by length (longest first), take top N
                    const longChunks = merged
                        .filter((c) => c.t_end - c.t_start >= 3.0)
                        .sort((a, b) => (b.t_end - b.t_start) - (a.t_end - a.t_start))
                        .slice(0, numClips);
                    // Cap each clip to clipLength
                    for (let i = 0; i < longChunks.length; i++) {
                        const c = longChunks[i];
                        const dur = Math.min(c.t_end - c.t_start, clipLength);
                        viralMoments.push({
                            rank: i + 1,
                            title: `${speakerFilter} #${i + 1}`,
                            quote: "",
                            t_start: c.t_start,
                            t_end: c.t_start + dur,
                            speaker: speakerFilter,
                        });
                    }
                }

                // Fallback: pick clips from speaker segments (skip "center" / b-roll)
                if (viralMoments.length === 0) {
                    // Only keep segments where a real speaker is focused
                    const speakerLabels = new Set(speakers.map((s: any) => s.label));
                    const speakerSegs = segments.filter((s: any) =>
                        s.focus && speakerLabels.has(s.focus) && (s.confidence ?? 1) > 0
                    );

                    // Merge adjacent segments only if same focus AND within 2s
                    const merged: { t_start: number; t_end: number; focus: string }[] = [];
                    for (const seg of speakerSegs) {
                        const last = merged[merged.length - 1];
                        if (last && last.focus === seg.focus && seg.t_start - last.t_end < 2.0) {
                            last.t_end = seg.t_end;
                        } else {
                            merged.push({ t_start: seg.t_start, t_end: seg.t_end, focus: seg.focus });
                        }
                    }

                    // Sort by length, take top N speaker chunks at least 5s long
                    const best = merged
                        .filter((c) => c.t_end - c.t_start >= 5.0)
                        .sort((a, b) => (b.t_end - b.t_start) - (a.t_end - a.t_start))
                        .slice(0, numClips);

                    if (best.length > 0) {
                        best.sort((a, b) => a.t_start - b.t_start);
                        for (let i = 0; i < best.length; i++) {
                            const c = best[i];
                            const dur = Math.min(c.t_end - c.t_start, clipLength);
                            viralMoments.push({
                                rank: i + 1,
                                title: `Clip ${i + 1}`,
                                quote: "",
                                t_start: c.t_start,
                                t_end: c.t_start + dur,
                                speaker: c.focus,
                            });
                        }
                    } else {
                        // Last resort: evenly spaced
                        const interval = duration / (numClips + 1);
                        for (let i = 1; i <= numClips; i++) {
                            const t = interval * i;
                            viralMoments.push({
                                rank: i,
                                title: `Clip ${i}`,
                                quote: "",
                                t_start: Math.max(0, t - clipLength / 2),
                                t_end: Math.min(duration, t + clipLength / 2),
                                speaker: speakers[0]?.label ?? "center",
                            });
                        }
                    }
                }

                // Step 3: Generate ffmpeg commands for each clip
                send("status", { step: "generating", message: `Generating ${viralMoments.length} ${orientation} clips...` });

                // Fill-frame cropping (no black bars):
                // Vertical (9:16): fill height 1920, crop width 1080 from center.
                //   A 640x360 source becomes ~3x zoomed into the center third.
                // Horizontal (16:9): fill width 1920, crop height 1080 from center.
                //   A 16:9 source fits exactly with no cropping.
                const outW = orientation === "vertical" ? 1080 : 1920;
                const outH = orientation === "vertical" ? 1920 : 1080;

                const clips: any[] = [];
                for (const moment of viralMoments) {
                    const outputFile = `/tmp/viral_clip_${moment.rank}.mp4`;
                    const dur = moment.t_end - moment.t_start;

                    let vf: string;
                    if (orientation === "vertical") {
                        // Fill height, crop width from center — proper reel look
                        vf = `scale=-2:${outH},crop=${outW}:${outH}:(iw-${outW})/2:0`;
                    } else {
                        // Fill width, crop height from center — works for 16:9 and taller
                        vf = `scale=${outW}:-2,crop=${outW}:${outH}:0:(ih-${outH})/2`;
                    }

                    const ffmpegCmd = `/opt/homebrew/bin/ffmpeg -hide_banner -y -ss ${moment.t_start.toFixed(2)} -t ${dur.toFixed(2)} -i "${videoPath}" -vf "${vf}" -c:a aac -b:a 128k "${outputFile}"`;

                    clips.push({
                        ...moment,
                        duration: dur,
                        orientation,
                        ffmpeg_command: ffmpegCmd,
                        output_file: outputFile,
                    });
                }

                send("clips", { clips });

                // Step 4: Speaker highlight reels
                if (speakerHighlights && speakers.length > 0) {
                    send("status", { step: "highlights", message: "Building speaker highlight reels..." });

                    const highlights: any[] = [];
                    for (const speaker of speakers) {
                        const speakerSegs = segments.filter((s: any) => s.focus === speaker.label);
                        // Merge adjacent and filter short
                        const merged: any[] = [];
                        for (const seg of speakerSegs) {
                            if (merged.length > 0 && seg.t_start - merged[merged.length - 1].t_end < 1.0) {
                                merged[merged.length - 1].t_end = seg.t_end;
                            } else {
                                merged.push({ ...seg });
                            }
                        }
                        const longEnough = merged.filter((s: any) => (s.t_end - s.t_start) >= 3.0);
                        const totalTime = longEnough.reduce((sum: number, s: any) => sum + (s.t_end - s.t_start), 0);

                        // Build segment list
                        const concatParts = longEnough.slice(0, 20).map((s: any) => ({
                            t_start: s.t_start,
                            t_end: s.t_end,
                            duration: s.t_end - s.t_start,
                        }));

                        highlights.push({
                            speaker: speaker.label,
                            color: speaker.color,
                            total_segments: longEnough.length,
                            total_time: Math.round(totalTime),
                            clips: concatParts,
                        });
                    }

                    send("highlights", { highlights });
                }

                send("complete", {
                    total_clips: clips.length,
                    speakers: speakers.length,
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
