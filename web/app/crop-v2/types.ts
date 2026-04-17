export type Speaker = {
    id: number;
    label: string;
    color: string;
    frames_seen: number;
    median_center: [number, number];
    avg_area: number;
};

export type CropSegment = {
    t_start: number;
    t_end: number;
    crop_x: number;
    crop_y: number;
    focus: string;
    confidence: number;
};

export type FramePreview = {
    index: number;
    timestamp: number;
    imageB64: string;
    segment: CropSegment | null;
};

export type AnalysisPlan = {
    duration: number;
    source_width: number;
    source_height: number;
    analysis_time_seconds?: number;
    speakers?: Speaker[];
    segments?: CropSegment[];
};

export type ViralClip = {
    rank: number;
    title: string;
    quote?: string;
    why?: string;
    t_start: number;
    t_end: number;
    ffmpeg_command: string;
    output_file: string;
    speaker?: string;
    color?: string;
};

export type Thumbnail = {
    timestamp: number;
    score: number;
    imageB64: string;
};

// An "effect" represents an applied post-render feature in order.
export type EffectKind =
    | "subtitles"
    | "fillers"
    | "hook"
    | "active-crop"
    | "thumbnails";

export type AppliedEffect = {
    kind: EffectKind;
    label: string;
};

export type Orientation = "vertical" | "horizontal";

export type RenderState =
    | { phase: "idle" }
    | { phase: "running"; step: string; progress: number }
    | { phase: "done" }
    | { phase: "error"; message: string };
