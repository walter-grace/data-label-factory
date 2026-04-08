// canvas-utils.ts — pure functions for canvas coord transforms + hit testing

import type { Bbox } from "./types";

export type Viewport = {
    scale: number;       // image pixels → canvas pixels multiplier
    offsetX: number;     // top-left of image in canvas coords
    offsetY: number;
};

/** Compute the viewport that fits an image inside a canvas, preserving aspect ratio. */
export function fitViewport(
    imgW: number,
    imgH: number,
    canvasW: number,
    canvasH: number,
    padding = 0.05,
): Viewport {
    const padPx = Math.min(canvasW, canvasH) * padding;
    const availW = canvasW - padPx * 2;
    const availH = canvasH - padPx * 2;
    const scale = Math.min(availW / imgW, availH / imgH);
    const offsetX = (canvasW - imgW * scale) / 2;
    const offsetY = (canvasH - imgH * scale) / 2;
    return { scale, offsetX, offsetY };
}

/** Apply zoom around a point in canvas coords (e.g. mouse cursor). */
export function zoomAt(
    vp: Viewport,
    canvasX: number,
    canvasY: number,
    factor: number,
): Viewport {
    // The image-space point under (canvasX, canvasY) before zoom:
    const imgX = (canvasX - vp.offsetX) / vp.scale;
    const imgY = (canvasY - vp.offsetY) / vp.scale;
    const newScale = vp.scale * factor;
    // Adjust offsets so that same image-space point lands under the same canvas point:
    return {
        scale: newScale,
        offsetX: canvasX - imgX * newScale,
        offsetY: canvasY - imgY * newScale,
    };
}

/** Convert image-pixel coords → canvas coords. */
export function imageToCanvas(vp: Viewport, x: number, y: number) {
    return { cx: vp.offsetX + x * vp.scale, cy: vp.offsetY + y * vp.scale };
}

/** Convert canvas coords → image-pixel coords. */
export function canvasToImage(vp: Viewport, cx: number, cy: number) {
    return { x: (cx - vp.offsetX) / vp.scale, y: (cy - vp.offsetY) / vp.scale };
}

/** Hit test: which bbox (by index) contains the canvas point? Returns the SMALLEST. */
export function hitBbox(
    bboxes: Bbox[],
    canvasX: number,
    canvasY: number,
    vp: Viewport,
): number | null {
    const { x, y } = canvasToImage(vp, canvasX, canvasY);
    let bestIdx: number | null = null;
    let bestArea = Infinity;
    for (let i = 0; i < bboxes.length; i++) {
        const b = bboxes[i];
        if (x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2) {
            const area = (b.x2 - b.x1) * (b.y2 - b.y1);
            if (area < bestArea) {
                bestArea = area;
                bestIdx = i;
            }
        }
    }
    return bestIdx;
}
