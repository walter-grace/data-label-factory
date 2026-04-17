import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const MAC_MINI = "bigneek@192.168.1.244";
const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const FONT_FILE = "/System/Library/Fonts/Helvetica.ttc";

type IncomingClip = {
    id: string;
    src: string;
    label: string;
    sourceDuration: number;
    in: number;
    out: number;
    path?: string;
    transitionIn?: { kind: string; duration: number };
};

type IncomingText = {
    id: string;
    content: string;
    start: number;
    end: number;
    style?: string;
    animation?: string;
};

type IncomingAudio = {
    id: string;
    path: string;
    label: string;
    start: number;
    end: number;
    volume: number;
};

type IncomingScene = {
    clips: IncomingClip[];
    texts: IncomingText[];
    audio: IncomingAudio[];
    orientation: "vertical" | "horizontal";
};

function sanitizeTmpPath(p: string): string | null {
    if (!p.startsWith("/tmp/")) return null;
    if (p.includes("'") || p.includes(";") || p.includes("&") || p.includes("`") || p.includes("$")) return null;
    if (p.includes("..")) return null;
    return p;
}

function hashScene(scene: IncomingScene): string {
    const payload = JSON.stringify({
        clips: scene.clips.map((c) => [c.path ?? c.src, c.in, c.out, c.transitionIn?.kind ?? "", c.transitionIn?.duration ?? 0]),
        texts: scene.texts.map((t) => [t.content, t.start, t.end, t.style ?? "", t.animation ?? ""]),
        audio: scene.audio.map((a) => [a.path, a.start, a.end, a.volume]),
        orientation: scene.orientation,
    });
    let h = 0;
    for (let i = 0; i < payload.length; i++) h = (h * 31 + payload.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
}

function escapeDrawtext(s: string): string {
    return s
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\u2019")
        .replace(/:/g, "\\:")
        .replace(/%/g, "\\%");
}

function stylePreset(style?: string): { fontsize: number; color: string; border: number } {
    switch (style) {
        case "title":
            return { fontsize: 64, color: "white", border: 4 };
        case "caption":
            return { fontsize: 36, color: "yellow", border: 3 };
        case "hook":
            return { fontsize: 52, color: "red", border: 4 };
        default:
            return { fontsize: 44, color: "white", border: 3 };
    }
}

function baseDrawtext(
    text: string,
    fontsize: number,
    color: string,
    border: number,
    enableExpr: string,
    extra: string = "",
): string {
    return (
        `drawtext=fontfile=${FONT_FILE}:text='${text}':fontsize=${fontsize}:fontcolor=${color}:` +
        `borderw=${border}:bordercolor=black@0.9:box=1:boxcolor=black@0.45:boxborderw=20:` +
        `x=(w-text_w)/2:y=h-text_h-120${extra}:enable=${enableExpr}`
    );
}

function buildTextFilter(t: IncomingText): string[] {
    if (!t.content) return [];
    const st = stylePreset(t.style);
    const start = Math.max(0, Number(t.start) || 0);
    const end = Math.max(start + 0.1, Number(t.end) || start + 0.1);
    const dur = end - start;
    const text = escapeDrawtext(t.content);
    const S = start.toFixed(3);
    const E = end.toFixed(3);
    const animation = (t.animation ?? "none") as string;

    const enableRange = `'between(t,${S},${E})'`;

    if (animation === "fade") {
        // lerp alpha in first 0.5s, out last 0.5s
        const fadeDur = Math.min(0.5, dur / 2).toFixed(3);
        const alphaExpr = `'if(lt(t,${S}+${fadeDur}),(t-${S})/${fadeDur},if(gt(t,${E}-${fadeDur}),(${E}-t)/${fadeDur},1))'`;
        return [baseDrawtext(text, st.fontsize, st.color, st.border, enableRange, `:alpha=${alphaExpr}`)];
    }
    if (animation === "slide-up") {
        const slideDur = Math.min(0.3, dur / 2);
        const slideEnd = (start + slideDur).toFixed(3);
        // y starts at baseline+50 and eases up over slideDur seconds
        const yExpr = `'if(lt(t,${slideEnd}),h-text_h-120+(${slideEnd}-t)/${slideDur.toFixed(3)}*60,h-text_h-120)'`;
        // build drawtext manually because baseDrawtext hardcodes y
        return [
            `drawtext=fontfile=${FONT_FILE}:text='${text}':fontsize=${st.fontsize}:fontcolor=${st.color}:` +
                `borderw=${st.border}:bordercolor=black@0.9:box=1:boxcolor=black@0.45:boxborderw=20:` +
                `x=(w-text_w)/2:y=${yExpr}:enable=${enableRange}`,
        ];
    }
    if (animation === "pop") {
        const popEnd = (start + 0.15).toFixed(3);
        const popEnable = `'between(t,${S},${popEnd})'`;
        const restEnable = `'between(t,${popEnd},${E})'`;
        return [
            baseDrawtext(text, Math.round(st.fontsize * 1.3), st.color, st.border, popEnable),
            baseDrawtext(text, st.fontsize, st.color, st.border, restEnable),
        ];
    }
    if (animation === "typewriter") {
        // reveal one character at a time, each layer enabled from start+i*step until end
        const out: string[] = [];
        const chars = t.content;
        const step = Math.min(0.08, dur / Math.max(1, chars.length + 1));
        for (let i = 1; i <= chars.length; i++) {
            const sub = escapeDrawtext(chars.slice(0, i));
            const layerStart = (start + (i - 1) * step).toFixed(3);
            const layerEnd = i < chars.length ? (start + i * step).toFixed(3) : E;
            const en = `'between(t,${layerStart},${layerEnd})'`;
            out.push(baseDrawtext(sub, st.fontsize, st.color, st.border, en));
        }
        return out;
    }
    if (animation === "word-pop") {
        const words = t.content.split(/\s+/).filter(Boolean);
        if (words.length === 0) return [];
        const per = dur / words.length;
        return words.map((w, i) => {
            const wStart = (start + i * per).toFixed(3);
            const wEnd = i === words.length - 1 ? E : (start + (i + 1) * per).toFixed(3);
            const en = `'between(t,${wStart},${wEnd})'`;
            return baseDrawtext(escapeDrawtext(w), st.fontsize, st.color, st.border, en);
        });
    }
    if (animation === "word-highlight") {
        const words = t.content.split(/\s+/).filter(Boolean);
        if (words.length === 0) return [];
        const per = dur / words.length;
        const charApprox = 0.55;
        const spaceApprox = 0.5;
        const wordWidths = words.map((w) => w.length * charApprox * st.fontsize);
        const spaceW = spaceApprox * st.fontsize;
        const totalWidth = wordWidths.reduce((a, b) => a + b, 0) + (words.length - 1) * spaceW;
        const blueColor = "0x6aa8ff";
        const greenColor = "0x22e06b";
        const layers: string[] = [];
        let priorWidth = 0;
        for (let i = 0; i < words.length; i++) {
            const wEsc = escapeDrawtext(words[i]);
            const xExpr = `(w-${totalWidth.toFixed(1)})/2+${priorWidth.toFixed(1)}`;
            const wStart = (start + i * per).toFixed(3);
            const wEnd = i === words.length - 1 ? E : (start + (i + 1) * per).toFixed(3);
            const baseEnable = `'between(t,${S},${E})'`;
            const activeEnable = `'between(t,${wStart},${wEnd})'`;
            layers.push(
                `drawtext=fontfile=${FONT_FILE}:text='${wEsc}':fontsize=${st.fontsize}:fontcolor=${blueColor}:` +
                    `borderw=${st.border}:bordercolor=black@0.9:box=1:boxcolor=black@0.45:boxborderw=16:` +
                    `x=${xExpr}:y=h-text_h-120:enable=${baseEnable}`,
            );
            layers.push(
                `drawtext=fontfile=${FONT_FILE}:text='${wEsc}':fontsize=${st.fontsize}:fontcolor=${greenColor}:` +
                    `borderw=${st.border}:bordercolor=black@0.9:box=0:` +
                    `x=${xExpr}:y=h-text_h-120:enable=${activeEnable}`,
            );
            priorWidth += wordWidths[i] + spaceW;
        }
        return layers;
    }
    // none
    return [baseDrawtext(text, st.fontsize, st.color, st.border, enableRange)];
}

function xfadeKind(kind: string): string | null {
    switch (kind) {
        case "fade":
        case "crossfade":
            return "fade";
        case "slide-left":
            return "slideleft";
        case "slide-right":
            return "slideright";
        default:
            return null;
    }
}

export async function POST(req: Request) {
    let scene: IncomingScene;
    try {
        scene = (await req.json()) as IncomingScene;
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    if (!scene.clips || scene.clips.length === 0) {
        return NextResponse.json({ ok: false, error: "no clips" }, { status: 400 });
    }

    const { execSync } = await import("child_process");
    const hash = hashScene(scene);
    const finalPath = `/tmp/studio_${hash}_final.mp4`;

    const targetW = scene.orientation === "vertical" ? 1080 : 1920;
    const targetH = scene.orientation === "vertical" ? 1920 : 1080;

    try {
        const intermediates: { path: string; duration: number }[] = [];

        for (let i = 0; i < scene.clips.length; i++) {
            const c = scene.clips[i];
            const srcPath = c.path && sanitizeTmpPath(c.path) ? c.path : null;
            if (!srcPath) {
                return NextResponse.json(
                    { ok: false, error: `clip ${i} path invalid or outside /tmp/` },
                    { status: 400 },
                );
            }
            const inSec = Math.max(0, Number(c.in) || 0);
            const outSec = Math.max(inSec + 0.1, Number(c.out) || inSec + 0.1);
            const dur = outSec - inSec;
            const outPath = `/tmp/studio_${hash}_${i}_trim.mp4`;
            intermediates.push({ path: outPath, duration: dur });

            const vf =
                `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,` +
                `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

            const trimCmd =
                `${FFMPEG} -hide_banner -y -ss ${inSec.toFixed(3)} -t ${dur.toFixed(3)} -i '${srcPath}' ` +
                `-vf "${vf}" -r 30 -c:v libx264 -preset veryfast -crf 22 ` +
                `-c:a aac -ar 48000 -ac 2 -pix_fmt yuv420p '${outPath}'`;
            execSync(`ssh ${MAC_MINI} "${trimCmd.replace(/"/g, '\\"')}"`, {
                encoding: "utf-8",
                timeout: 180000,
            });
        }

        // Decide: concat demuxer (fast) vs xfade chain
        const hasTransition =
            scene.clips.length > 1 &&
            scene.clips.slice(1).some((c) => c.transitionIn && xfadeKind(c.transitionIn.kind) !== null);

        const concatOnlyPath = `/tmp/studio_${hash}_concat.mp4`;
        if (!hasTransition) {
            const concatListPath = `/tmp/studio_${hash}_list.txt`;
            const concatBody = intermediates.map((p) => `file '${p.path}'`).join("\n");
            execSync(`ssh ${MAC_MINI} "cat > '${concatListPath}'"`, {
                input: concatBody,
                encoding: "utf-8",
                timeout: 5000,
            });
            const concatCmd =
                `${FFMPEG} -hide_banner -y -f concat -safe 0 -i '${concatListPath}' -c copy '${concatOnlyPath}'`;
            execSync(`ssh ${MAC_MINI} "${concatCmd.replace(/"/g, '\\"')}"`, {
                encoding: "utf-8",
                timeout: 180000,
            });
        } else {
            // xfade chain — build filter_complex linking v/a streams
            const inputs = intermediates.map((im) => `-i '${im.path}'`).join(" ");
            const parts: string[] = [];
            // label initial streams
            let prevV = "[0:v]";
            let prevA = "[0:a]";
            let accDur = intermediates[0].duration;
            for (let i = 1; i < intermediates.length; i++) {
                const c = scene.clips[i];
                const t = c.transitionIn;
                const kind = t ? xfadeKind(t.kind) : null;
                const tDur = Math.max(0.1, Math.min(t?.duration ?? 0.5, intermediates[i].duration - 0.1, intermediates[i - 1].duration - 0.1));
                if (!kind) {
                    // cut — use xfade with 0 duration via fade kind to keep graph uniform
                    const offset = (accDur - 0.001).toFixed(3);
                    const vlabel = `[v${i}]`;
                    const alabel = `[a${i}]`;
                    parts.push(`${prevV}[${i}:v]xfade=transition=fade:duration=0.001:offset=${offset}${vlabel}`);
                    parts.push(`${prevA}[${i}:a]acrossfade=d=0.001${alabel}`);
                    prevV = vlabel;
                    prevA = alabel;
                    accDur += intermediates[i].duration - 0.001;
                } else {
                    const offset = (accDur - tDur).toFixed(3);
                    const vlabel = `[v${i}]`;
                    const alabel = `[a${i}]`;
                    parts.push(`${prevV}[${i}:v]xfade=transition=${kind}:duration=${tDur.toFixed(3)}:offset=${offset}${vlabel}`);
                    parts.push(`${prevA}[${i}:a]acrossfade=d=${tDur.toFixed(3)}${alabel}`);
                    prevV = vlabel;
                    prevA = alabel;
                    accDur += intermediates[i].duration - tDur;
                }
            }
            const filterComplex = parts.join(";");
            const xfadeCmd =
                `${FFMPEG} -hide_banner -y ${inputs} -filter_complex "${filterComplex}" ` +
                `-map '${prevV}' -map '${prevA}' -c:v libx264 -preset veryfast -crf 22 -c:a aac '${concatOnlyPath}'`;
            execSync(`ssh ${MAC_MINI} "${xfadeCmd.replace(/"/g, '\\"')}"`, {
                encoding: "utf-8",
                timeout: 300000,
            });
        }

        const textFilters: string[] = [];
        for (const t of scene.texts) {
            textFilters.push(...buildTextFilter(t));
        }

        const validAudio = scene.audio
            .filter((a) => sanitizeTmpPath(a.path))
            .map((a) => ({
                path: a.path,
                start: Math.max(0, Number(a.start) || 0),
                end: Math.max(0, Number(a.end) || 0),
                volume: Number(a.volume) || 1,
            }))
            .filter((a) => a.end > a.start);

        let cmd: string;
        if (textFilters.length === 0 && validAudio.length === 0) {
            execSync(`ssh ${MAC_MINI} "cp '${concatOnlyPath}' '${finalPath}'"`, {
                encoding: "utf-8",
                timeout: 10000,
            });
            cmd = "cp";
        } else {
            const inputs: string[] = [`-i '${concatOnlyPath}'`];
            validAudio.forEach((a) => {
                inputs.push(`-i '${a.path}'`);
            });

            const filterParts: string[] = [];
            let videoMap = "0:v";
            if (textFilters.length > 0) {
                filterParts.push(`[0:v]${textFilters.join(",")}[vout]`);
                videoMap = "[vout]";
            }

            let audioMap = "0:a?";
            if (validAudio.length > 0) {
                const audioLabels: string[] = ["[0:a]"];
                validAudio.forEach((a, idx) => {
                    const inputIdx = idx + 1;
                    const delayMs = Math.round(a.start * 1000);
                    const lbl = `a${idx}`;
                    filterParts.push(
                        `[${inputIdx}:a]volume=${a.volume.toFixed(2)},adelay=${delayMs}|${delayMs}[${lbl}]`,
                    );
                    audioLabels.push(`[${lbl}]`);
                });
                filterParts.push(
                    `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=first:dropout_transition=0[aout]`,
                );
                audioMap = "[aout]";
            }

            const filterComplex = filterParts.join(";");
            cmd =
                `${FFMPEG} -hide_banner -y ${inputs.join(" ")} ` +
                (filterComplex ? `-filter_complex "${filterComplex}" ` : "") +
                `-map '${videoMap}' -map '${audioMap}' ` +
                `-c:v libx264 -preset veryfast -crf 22 -c:a aac -shortest '${finalPath}'`;
            execSync(`ssh ${MAC_MINI} "${cmd.replace(/"/g, '\\"')}"`, {
                encoding: "utf-8",
                timeout: 300000,
            });
        }

        const size = execSync(
            `ssh ${MAC_MINI} "stat -f%z '${finalPath}' 2>/dev/null || stat -c%s '${finalPath}'"`,
            { encoding: "utf-8", timeout: 10000 },
        ).trim();

        return NextResponse.json({
            ok: true,
            path: finalPath,
            bytes: parseInt(size, 10) || 0,
            clips: scene.clips.length,
            command: cmd,
        });
    } catch (e) {
        const err = e as Error & { stderr?: Buffer | string };
        const stderr = err.stderr ? String(err.stderr).slice(-600) : "";
        return NextResponse.json(
            { ok: false, error: `${err.message ?? String(e)}${stderr ? " | " + stderr : ""}`.slice(0, 1200) },
            { status: 500 },
        );
    }
}
