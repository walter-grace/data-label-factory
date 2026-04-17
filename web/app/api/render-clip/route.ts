// /api/render-clip — runs an ffmpeg command on the Mac mini, then
// streams the resulting mp4 back so the browser can play it inline.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAC_MINI = "bigneek@192.168.1.244";

export async function POST(req: Request) {
    let body: { ffmpeg_command: string; output_file: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    const { ffmpeg_command, output_file } = body;

    // Validate the command starts with the expected ffmpeg path
    if (!ffmpeg_command.startsWith("/opt/homebrew/bin/ffmpeg")) {
        return NextResponse.json({ ok: false, error: "invalid command" }, { status: 400 });
    }

    try {
        const { execSync } = await import("child_process");

        // Run ffmpeg on the Mac mini
        console.log("[render-clip] command:", ffmpeg_command);
        execSync(`ssh ${MAC_MINI} '${ffmpeg_command}'`, {
            encoding: "utf-8",
            timeout: 120000,
        });

        // Stream the rendered file back
        const videoData = execSync(
            `ssh ${MAC_MINI} "cat '${output_file}'"`,
            { maxBuffer: 200 * 1024 * 1024, timeout: 60000 },
        );

        return new Response(videoData, {
            headers: {
                "Content-Type": "video/mp4",
                "Content-Length": String(videoData.byteLength),
                "Cache-Control": "public, max-age=3600",
            },
        });
    } catch (e) {
        return NextResponse.json(
            { ok: false, error: String(e).slice(0, 300) },
            { status: 500 },
        );
    }
}
