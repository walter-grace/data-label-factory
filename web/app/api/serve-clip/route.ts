// /api/serve-clip?path=/tmp/viral_clip_1_sub.mp4
// Streams a video file from the Mac mini to the browser.
//
// Strategy:
//   1. `stat` the file size + probe range header
//   2. `ssh ... dd` the requested byte window to the response body
// This way we handle multi-hundred-MB files without buffering into memory and
// we cooperate with <video> element byte-range requests for seeking.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAC_MINI = "bigneek@192.168.1.244";

function isSafePath(p: string): boolean {
    if (!p.startsWith("/tmp/")) return false;
    if (p.includes("..")) return false;
    if (/[;&|`$<>\n"']/.test(p)) return false;
    return true;
}

async function statRemote(filePath: string): Promise<number | null> {
    const { execFileSync } = await import("child_process");
    try {
        const out = execFileSync(
            "ssh",
            [MAC_MINI, "stat", "-f", "%z", filePath],
            { timeout: 10000, encoding: "utf-8" },
        ).trim();
        const n = parseInt(out, 10);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

async function streamRange(
    filePath: string,
    start: number,
    end: number,
): Promise<ReadableStream<Uint8Array>> {
    const { spawn } = await import("child_process");
    const length = end - start + 1;
    // dd: skip `start` bytes, read `length` bytes, block size 1MB
    const bs = 1024 * 1024;
    const skipBytes = start;
    const cmd = `dd if='${filePath}' bs=1 skip=${skipBytes} count=${length} 2>/dev/null`;
    // Using bs=1 is slow for large ranges; use two-stage: skip in large blocks, then trim.
    // Simpler: tail -c +(start+1) | head -c length
    const shellCmd = `tail -c +${start + 1} '${filePath}' | head -c ${length}`;
    void bs;
    void cmd;

    return new ReadableStream<Uint8Array>({
        start(controller) {
            const child = spawn("ssh", [MAC_MINI, shellCmd]);
            child.stdout.on("data", (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
            });
            child.stdout.on("end", () => controller.close());
            child.on("error", (err) => controller.error(err));
            child.on("close", (code) => {
                if (code !== 0 && code !== null) {
                    try {
                        controller.close();
                    } catch {}
                }
            });
        },
    });
}

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const filePath = searchParams.get("path");

    if (!filePath || !isSafePath(filePath)) {
        return new Response("invalid path", { status: 400 });
    }

    const size = await statRemote(filePath);
    if (size == null) {
        return new Response("file not found", { status: 404 });
    }

    const rangeHeader = req.headers.get("range");
    let start = 0;
    let end = size - 1;
    let status = 200;

    if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (m) {
            const s = m[1] ? parseInt(m[1], 10) : 0;
            const e = m[2] ? parseInt(m[2], 10) : size - 1;
            if (!Number.isNaN(s) && !Number.isNaN(e) && s <= e && e < size) {
                start = s;
                end = e;
                status = 206;
            }
        }
    }

    const length = end - start + 1;
    const body = await streamRange(filePath, start, end);

    const headers: Record<string, string> = {
        "Content-Type": "video/mp4",
        "Content-Length": String(length),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
    };
    if (status === 206) {
        headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }

    return new Response(body, { status, headers });
}
