/* Caption style types, helpers, and canvas drawing for the live
 * subtitle preview used by /crop-v2.
 *
 * The same `CaptionStyle` object powers:
 *   1. Live preview inside VideoCanvas (drawCaptions on the 2D canvas).
 *   2. Server-side baking via ffmpeg `subtitles` filter `force_style`.
 *
 * Font mapping: keep ONE browser font name and ONE Mac font name per
 * enum value. The Mac mini has Arial, Helvetica, Helvetica Neue, Impact,
 * and Courier New installed. Montserrat is NOT installed, so it falls
 * back to Helvetica Neue Bold when baking.
 */

export type CaptionFont =
    | "arial"
    | "helvetica"
    | "impact"
    | "montserrat"
    | "mono";

export type CaptionBackground = "none" | "box" | "shadow";

export type CaptionPosition = "top" | "middle" | "bottom";

export type CaptionHighlight = "none" | "word" | "line";

export type CaptionMode = "line" | "word";

export type CaptionStyle = {
    enabled: boolean;
    font: CaptionFont;
    size: number; // 16..96 in canvas px (relative to video pixel dims)
    color: string; // hex "#RRGGBB"
    outlineColor: string; // hex "#RRGGBB"
    outlineWidth: number; // 0..8 canvas px
    background: CaptionBackground;
    backgroundOpacity: number; // 0..1
    position: CaptionPosition;
    marginY: number; // distance from top/bottom edge in canvas px
    uppercase: boolean;
    bold: boolean;
    highlightMode: CaptionHighlight;
    highlightColor: string; // hex
    maxWordsPerLine: number; // wrap after N words
    /** "line" = multi-word line (classic). "word" = single big word pop. */
    mode: CaptionMode;
    /** Optional explicit Y position, 0..1 of frame height. Overrides
     *  `position`/`marginY` when set (e.g. after drag or nudge). */
    positionY?: number;
    /** Optional explicit X position, 0..1 of frame width. Overrides the
     *  centered default when set. */
    positionX?: number;
};

export type TranscriptWord = {
    word: string;
    start: number;
    end: number;
};

export type TranscriptSegment = {
    start: number;
    end: number;
    text: string;
    words: TranscriptWord[];
};

export type ActiveCaption = {
    text: string;
    words: TranscriptWord[];
    /** True when this active caption represents the single currently-spoken
     *  word (one-word / big-word TikTok style). `drawCaptions` uses this to
     *  render the token huge, centered, with a pop-in animation. */
    singleWord?: boolean;
};

/* ---------- defaults + presets ---------- */

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
    enabled: false,
    font: "impact",
    size: 72,
    color: "#FFFFFF",
    outlineColor: "#000000",
    outlineWidth: 8,
    background: "none",
    backgroundOpacity: 0.65,
    position: "bottom",
    marginY: 220,
    uppercase: true,
    bold: true,
    highlightMode: "none",
    highlightColor: "#FDE047",
    maxWordsPerLine: 3,
    mode: "line",
    positionY: undefined,
    positionX: undefined,
};

export const CAPTION_PRESETS: Record<string, CaptionStyle> = {
    classic: {
        ...DEFAULT_CAPTION_STYLE,
        enabled: true,
        font: "impact",
        size: 78,
        color: "#FFFFFF",
        outlineColor: "#000000",
        outlineWidth: 10,
        background: "none",
        position: "bottom",
        marginY: 260,
        uppercase: true,
        bold: true,
        highlightMode: "none",
        maxWordsPerLine: 3,
    },
    bold: {
        ...DEFAULT_CAPTION_STYLE,
        enabled: true,
        font: "impact",
        size: 96,
        color: "#FFFFFF",
        outlineColor: "#000000",
        outlineWidth: 12,
        background: "none",
        position: "bottom",
        marginY: 240,
        uppercase: true,
        bold: true,
        highlightMode: "none",
        maxWordsPerLine: 2,
    },
    wordpop: {
        ...DEFAULT_CAPTION_STYLE,
        enabled: true,
        font: "impact",
        size: 82,
        color: "#FFFFFF",
        outlineColor: "#000000",
        outlineWidth: 10,
        background: "none",
        position: "middle",
        marginY: 0,
        uppercase: true,
        bold: true,
        highlightMode: "word",
        highlightColor: "#FDE047",
        maxWordsPerLine: 3,
    },
    minimal: {
        ...DEFAULT_CAPTION_STYLE,
        enabled: true,
        font: "helvetica",
        size: 62,
        color: "#FFFFFF",
        outlineColor: "#000000",
        outlineWidth: 0,
        background: "box",
        backgroundOpacity: 0.6,
        position: "bottom",
        marginY: 260,
        uppercase: false,
        bold: true,
        highlightMode: "none",
        maxWordsPerLine: 4,
    },
    neon: {
        ...DEFAULT_CAPTION_STYLE,
        enabled: true,
        font: "impact",
        size: 86,
        color: "#FFFFFF",
        outlineColor: "#06B6D4",
        outlineWidth: 10,
        background: "none",
        position: "bottom",
        marginY: 260,
        uppercase: true,
        bold: true,
        highlightMode: "word",
        highlightColor: "#A5F3FC",
        maxWordsPerLine: 2,
    },
    oneword: {
        ...DEFAULT_CAPTION_STYLE,
        enabled: true,
        mode: "word",
        font: "impact",
        size: 72,
        color: "#FFFFFF",
        outlineColor: "#000000",
        outlineWidth: 6,
        background: "shadow",
        backgroundOpacity: 0.7,
        position: "middle",
        marginY: 0,
        uppercase: true,
        bold: true,
        highlightMode: "none",
        highlightColor: "#FDE047",
        maxWordsPerLine: 1,
    },
};

/* ---------- font resolution ---------- */

// Browser canvas-font stack for each enum value.
export function canvasFontFamily(f: CaptionFont): string {
    switch (f) {
        case "arial":
            return "Arial, 'Helvetica Neue', Helvetica, sans-serif";
        case "helvetica":
            return "'Helvetica Neue', Helvetica, Arial, sans-serif";
        case "impact":
            return "Impact, 'Arial Black', 'Helvetica Neue', sans-serif";
        case "montserrat":
            // Not installed in system; fall back to a heavy sans
            return "'Helvetica Neue', Helvetica, Arial, sans-serif";
        case "mono":
            return "'Courier New', Courier, monospace";
    }
}

// Font name written into ffmpeg `force_style`. Must match a font
// actually installed on the Mac mini render host.
export function ffmpegFontName(f: CaptionFont): string {
    switch (f) {
        case "arial":
            return "Arial";
        case "helvetica":
            return "Helvetica Neue";
        case "impact":
            return "Impact";
        case "montserrat":
            // Not installed, fall back
            return "Helvetica Neue";
        case "mono":
            return "Courier New";
    }
}

/* ---------- active caption lookup ---------- */

/**
 * Find the caption line to display at `currentTime`. Splits segments
 * into lines of `maxWordsPerLine` words, with each line inheriting
 * the time range of the words it contains so long segments don't
 * show all at once.
 */
export function getActiveCaptions(
    segments: TranscriptSegment[] | undefined,
    currentTime: number,
    style: CaptionStyle,
): ActiveCaption | null {
    if (!segments || !segments.length) return null;

    // One-word mode: find the SINGLE word whose [start, end] contains
    // currentTime. Returns null during silence between words.
    if (style.mode === "word") {
        for (const seg of segments) {
            if (currentTime < seg.start - 0.05) return null;
            if (currentTime > seg.end + 0.05) continue;
            const words = seg.words && seg.words.length > 0 ? seg.words : [];
            for (const w of words) {
                if (
                    currentTime >= w.start - 0.02 &&
                    currentTime <= w.end + 0.02
                ) {
                    const text = w.word.trim();
                    if (!text) return null;
                    return { text, words: [w], singleWord: true };
                }
            }
        }
        return null;
    }

    // Walk segments and split into fixed-size chunks of words.
    for (const seg of segments) {
        if (currentTime < seg.start - 0.05) return null; // before any segment
        if (currentTime > seg.end + 0.05) continue; // past this segment

        const words = seg.words && seg.words.length > 0
            ? seg.words
            : [{ word: seg.text, start: seg.start, end: seg.end }];

        const chunkSize = Math.max(1, style.maxWordsPerLine);
        for (let i = 0; i < words.length; i += chunkSize) {
            const chunk = words.slice(i, i + chunkSize);
            if (!chunk.length) continue;
            const cStart = chunk[0].start;
            const cEnd = chunk[chunk.length - 1].end;
            if (currentTime >= cStart - 0.05 && currentTime <= cEnd + 0.05) {
                const text = chunk.map((w) => w.word.trim()).join(" ").trim();
                return { text, words: chunk };
            }
        }
    }
    return null;
}

/* ---------- canvas drawing ---------- */

function hexToRgba(hex: string, alpha: number): string {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function drawCaptions(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    active: ActiveCaption,
    currentTime: number,
    style: CaptionStyle,
): void {
    if (!active || !active.text) return;

    const isOneWord = active.singleWord === true || style.mode === "word";

    // In one-word mode the word is rendered ~1.8x larger for TikTok punch.
    const effectiveSize = isOneWord ? style.size * 1.8 : style.size;
    // Default to UPPERCASE in one-word mode for impact (respects the
    // explicit toggle as a boost but overrides a false toggle).
    const effectiveUpper = isOneWord ? true : style.uppercase;

    const family = canvasFontFamily(style.font);
    const weight = style.bold ? "800" : "500";
    ctx.save();
    ctx.font = `${weight} ${effectiveSize}px ${family}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const raw = effectiveUpper ? active.text.toUpperCase() : active.text;

    // Word-level tokens with measured widths, so we can highlight & lay them out.
    const allTokens = active.words.map((w) => ({
        word: effectiveUpper ? w.word.trim().toUpperCase() : w.word.trim(),
        start: w.start,
        end: w.end,
    }));
    // If we have no word timings, fall back to one big token.
    if (allTokens.length === 0) {
        allTokens.push({ word: raw, start: 0, end: 0 });
    }

    // Measure tokens
    const spaceWidth = ctx.measureText(" ").width;
    const tokenMeasures = allTokens.map((t) => ({
        ...t,
        width: ctx.measureText(t.word).width,
    }));

    // Wrap tokens into lines that fit within ~88% of the frame width.
    // This guarantees captions never overflow, even if maxWordsPerLine is high.
    const maxLineWidth = w * 0.88;
    const lines: typeof tokenMeasures[] = [];
    let currentLine: typeof tokenMeasures = [];
    let currentLineWidth = 0;
    for (const tok of tokenMeasures) {
        const widthWithToken =
            currentLine.length === 0
                ? tok.width
                : currentLineWidth + spaceWidth + tok.width;
        if (currentLine.length > 0 && widthWithToken > maxLineWidth) {
            lines.push(currentLine);
            currentLine = [tok];
            currentLineWidth = tok.width;
        } else {
            currentLine.push(tok);
            currentLineWidth = widthWithToken;
        }
    }
    if (currentLine.length > 0) lines.push(currentLine);

    // Per-line total width (for centering)
    const lineWidths = lines.map((line) => {
        let total = 0;
        for (let i = 0; i < line.length; i++) {
            total += line[i].width;
            if (i < line.length - 1) total += spaceWidth;
        }
        return total;
    });
    const maxMeasuredLineWidth = Math.max(...lineWidths, 0);

    // Vertical position — explicit positionY wins, otherwise the classic
    // top/middle/bottom + marginY logic. Pivot around the CENTER of the
    // full stacked block (lineHeight * numLines).
    const lineHeight = effectiveSize * 1.15;
    const blockHeight = lineHeight * lines.length;
    let blockCenterY: number;
    if (typeof style.positionY === "number") {
        const py = Math.max(0.02, Math.min(0.98, style.positionY));
        blockCenterY = py * h;
    } else if (style.position === "top") {
        blockCenterY = style.marginY + blockHeight / 2;
    } else if (style.position === "bottom") {
        blockCenterY = h - style.marginY - blockHeight / 2;
    } else {
        blockCenterY = h / 2;
    }

    // Horizontal center — explicit positionX overrides the centered default.
    const cxCenter =
        typeof style.positionX === "number"
            ? Math.max(0.02, Math.min(0.98, style.positionX)) * w
            : w / 2;

    const paddingX = effectiveSize * 0.35;
    const paddingY = effectiveSize * 0.25;

    // One-word pop-in animation: the first ~120ms of a word's life, scale
    // from 0.8 → 1.1 → 1.0 ease-out. Same pattern as stickers so the vibe
    // matches. Pivot around the caption center.
    let popScale = 1;
    const firstToken = lines[0]?.[0];
    if (isOneWord && firstToken) {
        const age = currentTime - firstToken.start;
        if (age >= 0 && age < 0.12) {
            const t = age / 0.12; // 0..1
            if (t < 0.5) {
                popScale = 0.8 + (1.1 - 0.8) * (t / 0.5);
            } else {
                popScale = 1.1 + (1.0 - 1.1) * ((t - 0.5) / 0.5);
            }
        }
    }

    // Background box wraps the whole stacked block
    if (style.background === "box") {
        const bgX = cxCenter - maxMeasuredLineWidth / 2 - paddingX;
        const bgY = blockCenterY - blockHeight / 2 - paddingY / 2;
        const bgW = maxMeasuredLineWidth + paddingX * 2;
        const bgH = blockHeight + paddingY;
        ctx.fillStyle = `rgba(0, 0, 0, ${style.backgroundOpacity})`;
        const r = Math.min(16, effectiveSize * 0.2);
        ctx.save();
        if (popScale !== 1) {
            ctx.translate(cxCenter, blockCenterY);
            ctx.scale(popScale, popScale);
            ctx.translate(-cxCenter, -blockCenterY);
        }
        roundedRect(ctx, bgX, bgY, bgW, bgH, r);
        ctx.fill();
        ctx.restore();
    } else if (style.background === "shadow") {
        ctx.shadowColor = `rgba(0, 0, 0, ${style.backgroundOpacity})`;
        ctx.shadowBlur = Math.max(6, effectiveSize * 0.25);
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = Math.max(2, effectiveSize * 0.06);
    }

    // Apply pop-in scale around the caption block center for the text pass.
    if (popScale !== 1) {
        ctx.translate(cxCenter, blockCenterY);
        ctx.scale(popScale, popScale);
        ctx.translate(-cxCenter, -blockCenterY);
    }

    // Draw each line, stacked vertically around blockCenterY.
    const topLineY = blockCenterY - blockHeight / 2 + lineHeight / 2;
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const lineWidth = lineWidths[li];
        const cy = topLineY + li * lineHeight;

        let cursorX = cxCenter - lineWidth / 2;
        for (let i = 0; i < line.length; i++) {
            const tok = line[i];
            const tw = tok.width;
            const cx = cursorX + tw / 2;

            // Outline first
            if (style.outlineWidth > 0) {
                ctx.lineJoin = "round";
                ctx.miterLimit = 2;
                ctx.lineWidth = style.outlineWidth;
                ctx.strokeStyle = style.outlineColor;
                ctx.strokeText(tok.word, cx, cy);
            }

            // Fill: determine color based on highlight mode
            let fillColor = style.color;
            if (style.highlightMode === "word" && tok.end > 0) {
                if (
                    currentTime >= tok.start - 0.02 &&
                    currentTime <= tok.end + 0.04
                ) {
                    fillColor = style.highlightColor;
                }
            }
            ctx.fillStyle = fillColor;
            ctx.fillText(tok.word, cx, cy);

            cursorX += tw + spaceWidth;
        }
    }

    ctx.restore();
}

function roundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
}

/* ---------- ffmpeg force_style ---------- */

/**
 * Convert `#RRGGBB` to ASS color literal `&H00BBGGRR&` (alpha 00 = opaque).
 */
function hexToAssColor(hex: string, alpha00 = "00"): string {
    const h = hex.replace("#", "");
    const r = h.slice(0, 2).toUpperCase();
    const g = h.slice(2, 4).toUpperCase();
    const b = h.slice(4, 6).toUpperCase();
    return `&H${alpha00}${b}${g}${r}&`;
}

/**
 * Map a CaptionStyle to a `force_style=` value for the ffmpeg
 * `subtitles` filter. Returns the INNER string (no surrounding
 * force_style= wrapping). Commas are escaped as `\\,` so the caller
 * can wrap this in `force_style='...'` inside a `-vf` expression.
 *
 * Alignment codes (ASS):
 *   1 = bottom-left,   2 = bottom-center,  3 = bottom-right
 *   5 = top-left,      6 = top-center,     7 = top-right
 *   9 = middle-left,  10 = middle-center, 11 = middle-right
 */
export function captionStyleToForceStyle(
    s: CaptionStyle,
    frameHeight = 1920,
): string {
    const fields: Record<string, string | number> = {};
    const isOneWord = s.mode === "word";

    fields["FontName"] = ffmpegFontName(s.font);

    // libass uses PlayResY=288 as the default script resolution when
    // rendering an SRT, so a FontSize of 46 would render at
    // 46 * (frameHeight / 288) pixels — hundreds of px on a 1920-tall
    // clip. Scale our canvas-px size down so the baked caption matches
    // the live preview. Also clamp so huge margins/sizes stay readable.
    const assScale = 288 / Math.max(288, frameHeight);
    // One-word mode bumps the rendered size ~1.8x to match the canvas
    // preview's big-word pop.
    const effectiveSrcSize = isOneWord ? s.size * 1.8 : s.size;
    const scaledSize = Math.max(6, Math.round(effectiveSrcSize * assScale));
    fields["FontSize"] = scaledSize;

    fields["PrimaryColour"] = hexToAssColor(s.color);
    fields["OutlineColour"] = hexToAssColor(s.outlineColor);

    // Background box vs outline+shadow
    if (s.background === "box") {
        // Opaque box. 80 = half-transparent in ASS alpha (00=opaque, FF=clear).
        const a = Math.round((1 - s.backgroundOpacity) * 255)
            .toString(16)
            .padStart(2, "0")
            .toUpperCase();
        fields["BackColour"] = hexToAssColor("#000000", a);
        fields["BorderStyle"] = 3; // opaque box
    } else {
        fields["BackColour"] = hexToAssColor("#000000", "80");
        fields["BorderStyle"] = 1; // outline + shadow
    }

    // Outline width is also in ASS units — scale it alongside font size
    // so the proportion matches the live preview.
    fields["Outline"] = Math.max(
        0,
        Math.round(s.outlineWidth * assScale),
    );
    fields["Shadow"] = s.background === "shadow" ? 1 : 0;

    // Alignment. When an explicit positionY is set, derive a top-aligned
    // anchor (Alignment=8) and convert positionY → MarginV so the caption
    // lands where the user dragged/nudged it.
    let align: number;
    let marginVCanvasPx: number;
    let marginLCanvasPx = 0;
    let marginRCanvasPx = 0;

    if (typeof s.positionY === "number") {
        // Use top-center anchor (Alignment=8) and treat MarginV as the
        // distance from the top edge. ASS alignment 7/8/9 = top.
        // If positionX is set and off-center, shift to top-left anchor
        // (7) and use MarginL; otherwise keep centered.
        const py = Math.max(0.02, Math.min(0.98, s.positionY));
        const targetY = py * frameHeight;
        // The baseline of the caption in ASS is the anchor point, not
        // the centerline — but close enough for visual parity.
        marginVCanvasPx = Math.max(0, targetY);

        if (typeof s.positionX === "number") {
            const px = Math.max(0.02, Math.min(0.98, s.positionX));
            const frameWidth = Math.round((frameHeight * 9) / 16); // rough
            // Use top-left anchor so MarginL works naturally
            align = 7;
            marginLCanvasPx = Math.max(0, px * frameWidth);
            marginRCanvasPx = 0;
        } else {
            align = 8;
        }
    } else {
        if (s.position === "top") align = 8;
        else if (s.position === "middle") align = 10;
        else align = 2;
        marginVCanvasPx = s.marginY;
    }
    fields["Alignment"] = align;

    // MarginV is in ASS units (PlayResY=288) so it also needs scaling
    // from the canvas-px value the user picked.
    const mv = Math.max(
        0,
        Math.min(
            Math.round(frameHeight * assScale) - 4,
            Math.round(marginVCanvasPx * assScale),
        ),
    );
    fields["MarginV"] = mv;
    if (marginLCanvasPx > 0) {
        fields["MarginL"] = Math.max(
            0,
            Math.round(marginLCanvasPx * assScale),
        );
    }
    if (marginRCanvasPx > 0) {
        fields["MarginR"] = Math.max(
            0,
            Math.round(marginRCanvasPx * assScale),
        );
    }

    fields["Bold"] = s.bold ? 1 : 0;
    fields["Italic"] = 0;
    fields["Underline"] = 0;
    fields["StrikeOut"] = 0;

    // Comma-separated key=value, but commas escaped as \\, because
    // the ffmpeg subtitles filter uses comma as a separator inside the
    // -vf chain.
    const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
    return parts.join("\\\\,");
}

/**
 * Convenience: should captions be sent to the server at all?
 */
export function hasCaptionStyleOverrides(s?: CaptionStyle | null): boolean {
    if (!s) return false;
    return s.enabled;
}
