// iou-tracker.ts — minimal SORT-style tracker, no external deps.
//
// Maintains persistent track IDs across frames by greedy IoU matching.
// Designed for objects that move smoothly between successive samples
// (drones in air, vehicles on a road, people walking). For erratic motion
// you'd want ByteTrack or a Kalman filter — this is intentionally simple.

export type Detection = {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    score?: number;
    label?: string;
    ref_url?: string;
    price?: {
        median?: number;
        min?: number;
        max?: number;
        currency?: string;
        usd_median?: number;
        usd_min?: number;
        usd_max?: number;
    } | null;
};

export type Track = Detection & {
    id: number;
    age: number;              // total frames this track has existed
    hits: number;             // frames where the track was matched
    framesSinceSeen: number;  // frames since last successful match
    color: string;
};

export type TrackerOptions = {
    /** Minimum IoU for a detection to be associated with an existing track. */
    iouThreshold?: number;
    /** Tracks unseen for more than this many frames are retired. */
    maxFramesUnseen?: number;
    /** Color palette to cycle through for new tracks. Should match the canvas-UI palette. */
    palette?: string[];
};

const DEFAULT_PALETTE = [
    "#22d3ee", // cyan
    "#10b981", // emerald
    "#3b82f6", // blue
    "#fbbf24", // amber
    "#a855f7", // purple
    "#ec4899", // pink
    "#f97316", // orange
    "#84cc16", // lime
];

export function iou(a: Detection, b: Detection): number {
    const x1 = Math.max(a.x1, b.x1);
    const y1 = Math.max(a.y1, b.y1);
    const x2 = Math.min(a.x2, b.x2);
    const y2 = Math.min(a.y2, b.y2);
    const interW = Math.max(0, x2 - x1);
    const interH = Math.max(0, y2 - y1);
    const inter = interW * interH;
    if (inter === 0) return 0;
    const aArea = (a.x2 - a.x1) * (a.y2 - a.y1);
    const bArea = (b.x2 - b.x1) * (b.y2 - b.y1);
    const union = aArea + bArea - inter;
    return union > 0 ? inter / union : 0;
}

export class IoUTracker {
    private tracks: Track[] = [];
    private nextId = 1;
    private opts: Required<TrackerOptions>;

    constructor(opts: TrackerOptions = {}) {
        this.opts = {
            iouThreshold: opts.iouThreshold ?? 0.3,
            maxFramesUnseen: opts.maxFramesUnseen ?? 5,
            palette: opts.palette ?? DEFAULT_PALETTE,
        };
    }

    /** Process a new frame's detections. Returns the updated active tracks. */
    update(detections: Detection[]): Track[] {
        // Build IoU matrix between (existing tracks) × (new detections)
        const matches = new Map<number, number>(); // trackIdx -> detIdx
        const usedDets = new Set<number>();
        const usedTracks = new Set<number>();

        // Greedy: pick best pair, mark used, repeat
        type Pair = { ti: number; di: number; iou: number };
        const pairs: Pair[] = [];
        for (let ti = 0; ti < this.tracks.length; ti++) {
            for (let di = 0; di < detections.length; di++) {
                const score = iou(this.tracks[ti], detections[di]);
                if (score >= this.opts.iouThreshold) {
                    pairs.push({ ti, di, iou: score });
                }
            }
        }
        pairs.sort((a, b) => b.iou - a.iou);
        for (const p of pairs) {
            if (usedTracks.has(p.ti) || usedDets.has(p.di)) continue;
            matches.set(p.ti, p.di);
            usedTracks.add(p.ti);
            usedDets.add(p.di);
        }

        // Update matched tracks with new detections
        for (const [ti, di] of matches) {
            const t = this.tracks[ti];
            const d = detections[di];
            t.x1 = d.x1; t.y1 = d.y1; t.x2 = d.x2; t.y2 = d.y2;
            t.score = d.score ?? t.score;
            t.label = d.label ?? t.label;
            t.ref_url = d.ref_url ?? t.ref_url;
            t.price = d.price ?? t.price;
            t.age += 1;
            t.hits += 1;
            t.framesSinceSeen = 0;
        }

        // Increment unseen counter on unmatched tracks
        for (let ti = 0; ti < this.tracks.length; ti++) {
            if (!usedTracks.has(ti)) {
                this.tracks[ti].age += 1;
                this.tracks[ti].framesSinceSeen += 1;
            }
        }

        // Spawn new tracks for unmatched detections
        for (let di = 0; di < detections.length; di++) {
            if (usedDets.has(di)) continue;
            const id = this.nextId++;
            this.tracks.push({
                ...detections[di],
                id,
                age: 1,
                hits: 1,
                framesSinceSeen: 0,
                color: this.opts.palette[(id - 1) % this.opts.palette.length],
            });
        }

        // Retire stale tracks
        this.tracks = this.tracks.filter((t) => t.framesSinceSeen <= this.opts.maxFramesUnseen);

        return this.activeTracks();
    }

    /** Tracks visible in the most recent frame (framesSinceSeen === 0). */
    activeTracks(): Track[] {
        return this.tracks.filter((t) => t.framesSinceSeen === 0);
    }

    /** Every track currently maintained, including ones recently lost. */
    allTracks(): Track[] {
        return [...this.tracks];
    }

    reset(): void {
        this.tracks = [];
        this.nextId = 1;
    }

    get totalTracksEverSeen(): number {
        return this.nextId - 1;
    }
}
