// /api/upload-video — receives a video file upload, transfers it to the Mac
// mini, returns the remote file path for use with /api/smart-crop.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAC_MINI = "bigneek@192.168.1.244";

export async function POST(req: Request) {
    try {
        const formData = await req.formData();
        const file = formData.get("video") as File | null;
        if (!file) {
            return NextResponse.json({ ok: false, error: "no video file" }, { status: 400 });
        }

        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);
        const ext = file.name.split(".").pop() ?? "mp4";
        const hash = Date.now().toString(36);
        const remotePath = `/tmp/smartcrop_upload_${hash}.${ext}`;

        // Write to local temp, then scp to Mac mini
        const fs = await import("fs");
        const os = await import("os");
        const path = await import("path");
        const { execSync } = await import("child_process");

        const localTmp = path.join(os.tmpdir(), `upload_${hash}.${ext}`);
        fs.writeFileSync(localTmp, buffer);

        execSync(`scp "${localTmp}" ${MAC_MINI}:"${remotePath}"`, { timeout: 60000 });
        fs.unlinkSync(localTmp);

        return NextResponse.json({
            ok: true,
            path: remotePath,
            size: buffer.length,
            name: file.name,
        });
    } catch (e) {
        return NextResponse.json(
            { ok: false, error: `upload failed: ${String(e).slice(0, 300)}` },
            { status: 500 },
        );
    }
}
