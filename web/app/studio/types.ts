export type TransitionKind = "cut" | "fade" | "crossfade" | "slide-left" | "slide-right";

export type ClipTransition = {
    kind: TransitionKind;
    duration: number;
};

export type ClipBlock = {
    id: string;
    src: string;
    label: string;
    sourceDuration: number;
    in: number;
    out: number;
    transitionIn?: ClipTransition;
};

export type TextStylePreset = "default" | "title" | "caption" | "hook";

export type TextAnimation =
    | "none"
    | "fade"
    | "slide-up"
    | "pop"
    | "typewriter"
    | "word-pop"
    | "word-highlight";

export type TextOverlay = {
    id: string;
    content: string;
    start: number;
    end: number;
    style?: TextStylePreset;
    animation?: TextAnimation;
};

export type AudioTrack = {
    id: string;
    path: string;
    label: string;
    start: number;
    end: number;
    volume: number;
    fadeIn?: number;
    fadeOut?: number;
};

export type SceneGraph = {
    clips: ClipBlock[];
    texts: TextOverlay[];
    audio: AudioTrack[];
    orientation: "vertical" | "horizontal";
};

export const emptyScene: SceneGraph = {
    clips: [],
    texts: [],
    audio: [],
    orientation: "vertical",
};

export function clipDuration(c: ClipBlock): number {
    return Math.max(0, c.out - c.in);
}

export function sceneDuration(s: SceneGraph): number {
    return s.clips.reduce((a, c) => a + clipDuration(c), 0);
}

export function clipAtTime(s: SceneGraph, t: number): { clip: ClipBlock; localTime: number; index: number } | null {
    let acc = 0;
    for (let i = 0; i < s.clips.length; i++) {
        const c = s.clips[i];
        const d = clipDuration(c);
        if (t < acc + d) return { clip: c, localTime: c.in + (t - acc), index: i };
        acc += d;
    }
    return null;
}

export function clipOffset(s: SceneGraph, index: number): number {
    let acc = 0;
    for (let i = 0; i < index && i < s.clips.length; i++) acc += clipDuration(s.clips[i]);
    return acc;
}

export function sceneHash(s: SceneGraph): string {
    const payload = JSON.stringify({
        clips: s.clips.map((c) => [c.src, c.in, c.out, c.transitionIn?.kind ?? "", c.transitionIn?.duration ?? 0]),
        texts: s.texts.map((t) => [t.content, t.start, t.end, t.style ?? "", t.animation ?? ""]),
        audio: s.audio.map((a) => [a.path, a.start, a.end, a.volume]),
        orientation: s.orientation,
    });
    let h = 0;
    for (let i = 0; i < payload.length; i++) {
        h = (h * 31 + payload.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36);
}

export function textActiveAt(s: SceneGraph, t: number): TextOverlay[] {
    return s.texts.filter((tx) => t >= tx.start && t < tx.end);
}
