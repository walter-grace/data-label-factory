// /api/smart-crop — downloads a YouTube video, runs multi-speaker YOLO tracking,
// returns crop plan + labeled frame thumbnails for the UI.
//
// POST { url, sample_fps?, segment_duration? }
// Returns SSE stream with: download progress, analysis frames with bboxes, crop plan

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900; // 15 min for long videos

const MAC_MINI = "bigneek@192.168.1.244";

export async function POST(req: Request) {
    let body: { url: string; sample_fps?: number; segment_duration?: number };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    const { url, sample_fps = 0.5, segment_duration = 3 } = body;
    if (!url) {
        return NextResponse.json({ ok: false, error: "url required" }, { status: 400 });
    }

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

                // Step 1: Get video — either download from YouTube or use a local/remote path
                let videoPath = "";

                if (url.startsWith("/") || url.startsWith("~")) {
                    // Local file path on Mac mini
                    videoPath = url;
                    send("status", { step: "downloaded", message: `Using file: ${videoPath}` });
                } else if (url.startsWith("http")) {
                    // YouTube / web URL — download via yt-dlp
                    send("status", { step: "downloading", message: `Downloading ${url}...` });
                    try {
                        // Download locally using android client (bypasses 403), then scp to Mac mini
                        const hash = url.match(/[?&]v=([^&]+)/)?.[1] ?? Date.now().toString(36);
                        const localPath = `/tmp/smartcrop_${hash}.mp4`;
                        const remotePath = `/tmp/smartcrop_${hash}.mp4`;

                        execSync(
                            `~/Library/Python/3.9/bin/yt-dlp --extractor-args "youtube:player_client=android" -f 'best[height<=720]/best' --no-playlist -o '${localPath}' '${url}'`,
                            { encoding: "utf-8", timeout: 180000 },
                        );

                        send("status", { step: "uploading", message: "Transferring to Mac mini..." });
                        execSync(`scp '${localPath}' ${MAC_MINI}:'${remotePath}'`, { timeout: 120000 });

                        videoPath = remotePath;
                    } catch (e) {
                        send("error", { error: `Download failed: ${String(e).slice(0, 200)}. Try uploading a file or using a file path instead.` });
                        controller.close();
                        return;
                    }
                    send("status", { step: "downloaded", message: `Downloaded to ${videoPath}` });
                } else {
                    send("error", { error: "Provide a YouTube URL or a file path on the Mac mini (e.g. /Users/bigneek/Desktop/video.mp4)" });
                    controller.close();
                    return;
                }

                // Step 2: Run smart crop analysis (stream progress via spawn instead of execSync)
                send("status", { step: "analyzing", message: "Detecting speakers with YOLO..." });

                const plan = await new Promise<any>((resolve, reject) => {
                    const { spawn } = require("child_process");
                    const proc = spawn("ssh", [MAC_MINI, `cd ~/Desktop/ffmpeg-mpc && python3 -c "
from ffmpeg_mcp_duplicate.multi_speaker_crop import plan_smart_crop
import json, sys
plan = plan_smart_crop(
    ffmpeg_path='/opt/homebrew/bin/ffmpeg',
    input_path='${videoPath}',
    sample_fps=${sample_fps},
    segment_duration=${segment_duration},
)
print(json.dumps(plan))
sys.stdout.flush()
"`]);
                    let stdout = "";
                    let stderr = "";

                    proc.stdout.on("data", (chunk: Buffer) => {
                        const text = chunk.toString();
                        stdout += text;
                        // Stream progress lines to the UI
                        for (const line of text.split("\n")) {
                            const trimmed = line.trim();
                            if (trimmed.startsWith("[smart-crop]") || trimmed.match(/^\d+\/\d+ /)) {
                                send("status", { step: "analyzing", message: trimmed });
                            }
                        }
                    });
                    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

                    const timeout = setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 900000);
                    proc.on("close", (code: number) => {
                        clearTimeout(timeout);
                        const jsonLine = stdout.trim().split("\n").filter((l: string) => l.startsWith("{")).pop();
                        if (jsonLine) {
                            try { resolve(JSON.parse(jsonLine)); } catch { reject(new Error("invalid JSON")); }
                        } else {
                            reject(new Error(stderr.slice(0, 300) || "no output"));
                        }
                    });
                });

                if (!plan.ok) {
                    send("error", { error: plan.error ?? "analysis failed" });
                    controller.close();
                    return;
                }

                send("plan", plan);

                // Step 3: Extract labeled thumbnail frames for the UI
                send("status", { step: "thumbnails", message: "Extracting preview frames..." });

                // Get ~20 evenly spaced frames for a richer preview
                const duration = plan.duration;
                const frameCount = Math.min(20, Math.max(6, Math.floor(duration / 5)));
                const frameInterval = duration / (frameCount + 1);

                for (let i = 1; i <= frameCount; i++) {
                    const t = frameInterval * i;
                    try {
                        const frameB64 = execSync(
                            `ssh ${MAC_MINI} "/opt/homebrew/bin/ffmpeg -hide_banner -loglevel error -ss ${t.toFixed(2)} -i '${videoPath}' -frames:v 1 -vf 'scale=640:-1' -f image2 -c:v png - 2>/dev/null | base64"`,
                            { encoding: "utf-8", timeout: 10000, maxBuffer: 10 * 1024 * 1024 },
                        ).trim();

                        if (frameB64) {
                            // Find which segment this timestamp belongs to
                            const seg = plan.segments?.find(
                                (s: any) => t >= s.t_start && t < s.t_end
                            );

                            send("frame", {
                                index: i - 1,
                                timestamp: parseFloat(t.toFixed(2)),
                                imageB64: frameB64,
                                segment: seg ?? null,
                            });
                        }
                    } catch {}
                }

                send("complete", {
                    speakers: plan.speakers,
                    segments: plan.segments?.length ?? 0,
                    ffmpeg_command: plan.ffmpeg_command,
                    analysis_time: plan.analysis_time_seconds,
                    video_path: videoPath,
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
