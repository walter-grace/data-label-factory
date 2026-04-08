// Types matching pod_label.py output format

export type Bbox = {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    x1_norm: number;
    y1_norm: number;
    x2_norm: number;
    y2_norm: number;
    cx_norm: number;
    cy_norm: number;
    w_norm: number;
    h_norm: number;
    area_fraction: number;
    annotation_id?: number;  // links to verified.json verdict (when present)
};

// VLM verdict from verify_vlm.py output
export type VlmVerdict = {
    annotation_id: number;
    image_id: number;
    image_file: string;
    category_name: string;
    bbox: number[];        // [x, y, w, h]
    verdict: "YES" | "NO" | "UNSURE";
    reasoning: string;
    elapsed: number;
};

export type VerifiedRun = {
    run_name: string;
    model: string;
    prompt_version: string;
    crop_padding: number;
    summary: {
        completed: number;
        total: number;
        yes: number;
        no: number;
        unsure: number;
        yes_rate: number;
        elapsed_seconds: number;
        avg_seconds_per_bbox: number;
    };
    annotations: VlmVerdict[];
};

export type QueryResult = {
    bboxes: Bbox[];
    count: number;
    elapsed?: number;
    error?: string;
};

export type ImageResult = {
    width: number;
    height: number;
    queries: Record<string, QueryResult>;
    error?: string;
};

export type LabelPartial = {
    completed: number;
    results: Record<string, ImageResult>;
};

// Verdicts: human review state stored alongside Falcon labels
export type BboxVerdict = "approved" | "rejected" | "unsure";

export type ImageReview = {
    image_path: string;            // R2 key (e.g. "raw/positive/fiber_spool_drone/foo.jpg")
    bucket: string;
    width: number;
    height: number;
    bboxes: Array<Bbox & {
        query: string;
        verdict?: BboxVerdict;     // human verdict
        vlm_verdict?: "YES" | "NO" | "UNSURE";  // Qwen verdict from verify_vlm.py
        vlm_reasoning?: string;
        note?: string;
    }>;
    image_verdict?: "approved" | "rejected" | "unsure";  // overall image-level call
    reviewed_at?: string;
};
