/* Canvas pixel + overlay effect helpers for /crop-v2.
 *
 * All effects operate on 2D canvas contexts directly. Pixel-level work
 * goes through `applyPixelEffects` (a single pass over the Uint8ClampedArray).
 * Overlay effects (vignette, grain, stickers) use canvas compositing
 * to avoid touching every pixel.
 */

export type CanvasFilter =
    | "none"
    | "bw"
    | "sepia"
    | "vintage"
    | "duotone"
    | "invert";

export type Sticker = {
    id: string;
    emoji: string;
    t: number; // seconds from clip start
    duration: number;
    x: number; // 0..1 relative horizontal
    y: number; // 0..1 relative vertical
};

export type CanvasEffects = {
    exposure: number; // -50..50
    contrast: number; // -50..50
    saturation: number; // -50..50
    warmth: number; // -50..50
    filter: CanvasFilter;
    vignette: boolean;
    grain: boolean;
    stickers: Sticker[];
};

export const DEFAULT_EFFECTS: CanvasEffects = {
    exposure: 0,
    contrast: 0,
    saturation: 0,
    warmth: 0,
    filter: "none",
    vignette: false,
    grain: false,
    stickers: [],
};

export function hasPixelWork(e: CanvasEffects): boolean {
    return (
        e.exposure !== 0 ||
        e.contrast !== 0 ||
        e.saturation !== 0 ||
        e.warmth !== 0 ||
        e.filter !== "none"
    );
}

export function countActiveEffects(e: CanvasEffects): number {
    let n = 0;
    if (e.exposure !== 0) n++;
    if (e.contrast !== 0) n++;
    if (e.saturation !== 0) n++;
    if (e.warmth !== 0) n++;
    if (e.filter !== "none") n++;
    if (e.vignette) n++;
    if (e.grain) n++;
    if (e.stickers.length) n += e.stickers.length;
    return n;
}

export function applyPixelEffects(
    data: Uint8ClampedArray,
    e: CanvasEffects,
): void {
    if (!hasPixelWork(e)) return;

    const expo = e.exposure * 2.55;
    const contrast = 1 + e.contrast / 100;
    const sat = 1 + e.saturation / 100;
    const warmR = e.warmth * 0.5;
    const warmB = -e.warmth * 0.5;
    const filter = e.filter;

    const len = data.length;
    for (let i = 0; i < len; i += 4) {
        let r = data[i];
        let g = data[i + 1];
        let b = data[i + 2];

        // Exposure (simple additive)
        if (expo !== 0) {
            r += expo;
            g += expo;
            b += expo;
        }

        // Contrast around mid-gray
        if (contrast !== 1) {
            r = (r - 128) * contrast + 128;
            g = (g - 128) * contrast + 128;
            b = (b - 128) * contrast + 128;
        }

        // Warmth (shift red up, blue down)
        if (warmR !== 0) {
            r += warmR;
            b += warmB;
        }

        // Saturation (luminance-based)
        if (sat !== 1) {
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            r = lum + (r - lum) * sat;
            g = lum + (g - lum) * sat;
            b = lum + (b - lum) * sat;
        }

        // Filter presets
        if (filter !== "none") {
            if (filter === "bw") {
                const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                r = g = b = gray;
            } else if (filter === "sepia") {
                const nr = r * 0.393 + g * 0.769 + b * 0.189;
                const ng = r * 0.349 + g * 0.686 + b * 0.168;
                const nb = r * 0.272 + g * 0.534 + b * 0.131;
                r = nr;
                g = ng;
                b = nb;
            } else if (filter === "invert") {
                r = 255 - r;
                g = 255 - g;
                b = 255 - b;
            } else if (filter === "duotone") {
                // teal shadows -> rose highlights
                const lum2 = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                r = 20 + lum2 * (245 - 20);
                g = 184 - lum2 * (184 - 90);
                b = 166 - lum2 * (166 - 140);
            } else if (filter === "vintage") {
                // desaturate + warm + slight fade
                const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                r = gray * 0.3 + r * 0.7 + 10;
                g = gray * 0.3 + g * 0.7 + 5;
                b = gray * 0.3 + b * 0.7 - 10;
            }
        }

        // Clamp
        data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
        data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
}

export function drawVignette(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
): void {
    const g = ctx.createRadialGradient(
        w / 2,
        h / 2,
        Math.min(w, h) * 0.3,
        w / 2,
        h / 2,
        Math.max(w, h) * 0.75,
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.65)");
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
}

export function drawGrain(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
): void {
    // Cheap grain: sprinkle small white dots at low alpha.
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = "white";
    const dotCount = Math.floor((w * h) / 800);
    for (let i = 0; i < dotCount; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        ctx.fillRect(x, y, 2, 2);
    }
    ctx.restore();
}

export function drawSticker(
    ctx: CanvasRenderingContext2D,
    s: Sticker,
    w: number,
    h: number,
    age: number,
): void {
    // Pop-in: scale from 0.5 -> 1.2 -> 1.0 in the first 400ms.
    let scale = 1;
    if (age < 0.4) {
        const p = age / 0.4;
        scale = 0.5 + 0.7 * (1 - (1 - p) * (1 - p));
        if (p > 0.7) scale = 1.2 - 0.2 * ((p - 0.7) / 0.3);
    }

    const baseSize = Math.min(w, h) * 0.18;
    const size = baseSize * scale;

    ctx.save();
    ctx.font = `${size}px -apple-system, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 4;
    ctx.fillText(s.emoji, s.x * w, s.y * h);
    ctx.restore();
}
