import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAC_MINI = "bigneek@192.168.1.244";

type LibraryClip = { label: string; path: string; size: number; mtime: number };

function prettyLabel(basename: string): string {
    return basename
        .replace(/\.mp4$/i, "")
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function GET() {
    try {
        const { execSync } = await import("child_process");
        const raw = execSync(
            `ssh ${MAC_MINI} "cd /tmp && /usr/bin/stat -f '%z %m %N' *.mp4 2>/dev/null | sort -k2 -nr"`,
            { timeout: 10000, encoding: "utf-8" },
        ).trim();

        if (!raw) return NextResponse.json({ ok: true, clips: [] as LibraryClip[] });

        const clips: LibraryClip[] = [];
        for (const line of raw.split("\n")) {
            const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
            if (!m) continue;
            const size = parseInt(m[1], 10);
            const mtime = parseInt(m[2], 10);
            const name = m[3].trim();
            if (!name || name.startsWith("._")) continue;
            if (/^studio_/i.test(name)) continue;
            if (/_trim\.mp4$/i.test(name)) continue;
            if (/_concat\.mp4$/i.test(name)) continue;
            if (size < 10_000) continue;
            clips.push({
                label: prettyLabel(name),
                path: `/tmp/${name}`,
                size,
                mtime,
            });
        }

        return NextResponse.json({ ok: true, clips });
    } catch (e) {
        const err = e as Error;
        return NextResponse.json(
            { ok: false, error: err.message ?? String(e), clips: [] },
            { status: 500 },
        );
    }
}
