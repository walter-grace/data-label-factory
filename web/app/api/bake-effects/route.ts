// /api/bake-effects — takes canvas preview effects and bakes them into a new
// mp4 via ffmpeg filter chain. Maps each JS effect to the equivalent ffmpeg
// filter so "what you see in the browser" ≈ "what gets exported".

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAC_MINI = "bigneek@192.168.1.244";

type Sticker = {
    id: string;
    emoji: string;
    t: number;
    duration: number;
    x: number; // 0..1
    y: number; // 0..1
};

type CanvasEffects = {
    exposure: number;      // -50..50
    contrast: number;      // -50..50
    saturation: number;    // -50..50
    warmth: number;        // -50..50
    filter: "none" | "bw" | "sepia" | "vintage" | "duotone" | "invert";
    vignette: boolean;
    grain: boolean;
    stickers: Sticker[];
};

// Map canvas effects → ffmpeg filter chain
function buildFilterChain(e: CanvasEffects): string[] {
    const chain: string[] = [];

    // Exposure: add/subtract brightness. In ffmpeg, eq=brightness is -1..1 (maps to ±255 exposure)
    // Our JS exposure is -50..50 mapping to ±127 in pixel space → brightness ≈ exposure/100
    if (e.exposure !== 0) {
        const brightness = (e.exposure / 100).toFixed(3);
        chain.push(`eq=brightness=${brightness}`);
    }

    // Contrast: eq contrast is 0..2 where 1 is unchanged. Our -50..50 maps to 0.5..1.5
    if (e.contrast !== 0) {
        const contrast = (1 + e.contrast / 100).toFixed(3);
        chain.push(`eq=contrast=${contrast}`);
    }

    // Saturation: eq saturation is 0..3. Our -50..50 maps to 0.5..1.5
    if (e.saturation !== 0) {
        const sat = (1 + e.saturation / 100).toFixed(3);
        chain.push(`eq=saturation=${sat}`);
    }

    // Warmth: shift red up and blue down via colorbalance
    if (e.warmth !== 0) {
        const rs = (e.warmth / 100).toFixed(3); // -0.5..0.5
        const bs = (-e.warmth / 100).toFixed(3);
        chain.push(`colorbalance=rs=${rs}:bs=${bs}`);
    }

    // Filter presets
    switch (e.filter) {
        case "bw":
            chain.push("hue=s=0");
            break;
        case "sepia":
            // Canonical sepia matrix
            chain.push("colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131");
            break;
        case "invert":
            chain.push("negate");
            break;
        case "vintage":
            // Desaturate + warm + slight fade
            chain.push("eq=saturation=0.7:brightness=0.03");
            chain.push("colorbalance=rs=0.15:gs=0.05:bs=-0.1");
            break;
        case "duotone":
            // Approximate the teal→rose duotone via colorchannelmixer
            // Map luminance to a teal-rose ramp using curves would be more precise, but this is close
            chain.push("hue=s=0"); // first desaturate
            chain.push("colorchannelmixer=0.96:0:0:0:0.35:0.3:0:0:0.65:0.25:0:0");
            break;
    }

    // Vignette
    if (e.vignette) {
        chain.push("vignette=PI/4");
    }

    // Grain
    if (e.grain) {
        chain.push("noise=c0s=20:c0f=t+u");
    }

    return chain;
}

// Build the full filter_complex string. Stickers are passed as overlay inputs
// (emoji PNGs pre-rendered with PIL since ffmpeg drawtext can't handle color
// emoji fonts).
function buildFilterComplex(effects: CanvasEffects, stickerInputs: number): string {
    const videoFilters = buildFilterChain(effects);
    let videoChain = "[0:v]";
    if (videoFilters.length > 0) {
        videoChain += videoFilters.join(",");
        videoChain += "[v0]";
    } else {
        videoChain += "null[v0]";
    }

    if (stickerInputs === 0) {
        return videoChain;
    }

    // Each sticker is input [1:v], [2:v], etc. Overlay them one by one.
    const segments: string[] = [videoChain];
    let lastLabel = "[v0]";
    effects.stickers.forEach((s, i) => {
        const outLabel = `[v${i + 1}]`;
        const inputIdx = i + 1; // sticker input index
        // Overlay centered at (x*W, y*H) minus half sticker size (shifted by overlay_w/2)
        const xExpr = `main_w*${s.x.toFixed(3)}-overlay_w/2`;
        const yExpr = `main_h*${s.y.toFixed(3)}-overlay_h/2`;
        segments.push(
            `${lastLabel}[${inputIdx}:v]overlay=${xExpr}:${yExpr}:enable='between(t,${s.t.toFixed(2)},${(s.t + s.duration).toFixed(2)})'${outLabel}`
        );
        lastLabel = outLabel;
    });

    return segments.join(";");
}

export async function POST(req: Request) {
    let body: { output_file: string; effects: CanvasEffects };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    const { output_file, effects } = body;

    if (!output_file?.startsWith("/tmp/")) {
        return NextResponse.json({ ok: false, error: "invalid file path" }, { status: 400 });
    }

    const bakedPath = output_file.replace(/\.mp4$/, "_baked.mp4");

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

                // Step 1: Pre-render emoji stickers as PNGs via PIL on the Mac mini
                // (ffmpeg drawtext can't handle Apple Color Emoji — it's a bitmap font)
                const stickerPngs: string[] = [];
                if (effects.stickers.length > 0) {
                    send("status", { message: "Rendering emoji stickers..." });
                    const emojiList = effects.stickers.map(s => s.emoji).join("\x1f");
                    const renderScript = `
import sys
from PIL import Image, ImageDraw, ImageFont
emojis = sys.argv[1].split("\\x1f")
font = ImageFont.truetype("/System/Library/Fonts/Apple Color Emoji.ttc", 160)
for i, e in enumerate(emojis):
    img = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.text((10, 10), e, font=font, embedded_color=True)
    img.save(f"/tmp/_sticker_{i}.png")
print("OK")
`.trim();
                    execSync(
                        `ssh ${MAC_MINI} "cat > /tmp/_render_stickers.py"`,
                        { input: renderScript, encoding: "utf-8", timeout: 5000 },
                    );
                    execSync(
                        `ssh ${MAC_MINI} "/usr/bin/python3 /tmp/_render_stickers.py $'${emojiList.replace(/'/g, "\\'")}'"`,
                        { encoding: "utf-8", timeout: 15000 },
                    );
                    for (let i = 0; i < effects.stickers.length; i++) {
                        stickerPngs.push(`/tmp/_sticker_${i}.png`);
                    }
                }

                const filterComplex = buildFilterComplex(effects, stickerPngs.length);
                const finalMap = effects.stickers.length > 0 ? `[v${effects.stickers.length}]` : "[v0]";

                send("status", { message: "Baking canvas effects into mp4..." });
                send("filter", { filter_complex: filterComplex });

                // Build input args: main video + each sticker PNG
                const inputArgs = [`-i '${output_file}'`];
                for (const png of stickerPngs) {
                    inputArgs.push(`-i '${png}'`);
                }
                const inputStr = inputArgs.join(" ");
                const cmd = `/opt/homebrew/bin/ffmpeg -hide_banner -y ${inputStr} -filter_complex "${filterComplex}" -map "${finalMap}" -map '0:a?' -c:a copy '${bakedPath}'`;

                // Log what we're running
                send("ffmpeg_command", { command: cmd });

                execSync(
                    `ssh ${MAC_MINI} "${cmd.replace(/"/g, '\\"')}"`,
                    { encoding: "utf-8", timeout: 240000 },
                );

                send("complete", {
                    output_file: bakedPath,
                    effects_count: Object.keys(effects).filter(k => {
                        const v = (effects as any)[k];
                        if (typeof v === "number") return v !== 0;
                        if (typeof v === "boolean") return v;
                        if (Array.isArray(v)) return v.length > 0;
                        if (typeof v === "string") return v !== "none";
                        return false;
                    }).length,
                    sticker_count: effects.stickers.length,
                });
            } catch (e) {
                send("error", { error: String(e).slice(0, 600) });
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
