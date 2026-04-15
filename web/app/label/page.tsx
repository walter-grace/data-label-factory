"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";

const DLF_API = "/api/dlf";

type Provider = {
  name: string;
  alive: boolean;
  capabilities: string[];
  info?: string;
};

type FilterResult = {
  name: string;
  verdict: string;
  raw_answer: string;
  elapsed: number;
  confidence: number;
};

type Annotation = {
  bbox: number[];
  category: string;
  score: number;
  pass_rate?: number;
  failed_rules?: string[];
  source?: string;
};

type LabelResult = {
  annotations: Annotation[];
  elapsed: number;
  backend: string;
  image_size: number[];
  n_detections: number;
};

// ── Colors ──
const VERDICT_COLORS: Record<string, string> = {
  YES: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40",
  NO: "bg-red-500/20 text-red-400 border-red-500/40",
  UNKNOWN: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40",
  ERROR: "bg-red-800/20 text-red-300 border-red-800/40",
};

const BBOX_COLORS = [
  "#ff4060", "#20c8ff", "#ffc800", "#60ff60",
  "#c860ff", "#ff8000", "#00c8c8", "#ff60ff",
];

export default function LabelPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [filterBackend, setFilterBackend] = useState("gemma");
  const [labelBackend, setLabelBackend] = useState("falcon");
  const [filterResults, setFilterResults] = useState<FilterResult[]>([]);
  const [labelResults, setLabelResults] = useState<Map<string, LabelResult>>(new Map());
  const [selectedImage, setSelectedImage] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [apiStatus, setApiStatus] = useState<"checking" | "up" | "down">("checking");
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [askElapsed, setAskElapsed] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Check API + providers on mount
  useEffect(() => {
    fetch(`${DLF_API}?path=/api/health`)
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "ok") {
          setApiStatus("up");
          fetch(`${DLF_API}?path=/api/providers`)
            .then((r) => r.json())
            .then((d) => setProviders(d.providers || []));
        } else {
          setApiStatus("down");
        }
      })
      .catch(() => setApiStatus("down"));
  }, []);

  // Handle file selection
  const onFilesSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    setFiles(selected);
    setPreviews(selected.map((f) => URL.createObjectURL(f)));
    setFilterResults([]);
    setLabelResults(new Map());
    setSelectedImage(null);
  }, []);

  // Handle drop
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith("image/")
    );
    if (dropped.length) {
      setFiles(dropped);
      setPreviews(dropped.map((f) => URL.createObjectURL(f)));
      setFilterResults([]);
      setLabelResults(new Map());
      setSelectedImage(null);
    }
  }, []);

  // Run filter on all images
  const runFilter = async () => {
    if (!files.length || !description) return;
    setLoading(true);
    setFilterResults([]);

    const prompt = `Look at this image. Does it show a ${description}? Answer with exactly one word: YES or NO.`;
    const results: FilterResult[] = [];

    for (let i = 0; i < files.length; i++) {
      setLoadingMsg(`Filtering ${i + 1}/${files.length}...`);
      const form = new FormData();
      form.append("image", files[i]);
      form.append("prompt", prompt);
      form.append("backend", filterBackend);

      try {
        const res = await fetch(`${DLF_API}?path=/api/filter`, {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        results.push({ name: files[i].name, ...data });
      } catch (e: any) {
        results.push({
          name: files[i].name,
          verdict: "ERROR",
          raw_answer: e.message,
          elapsed: 0,
          confidence: 0,
        });
      }
      setFilterResults([...results]);
    }
    setLoading(false);
    setLoadingMsg("");
  };

  // Run label on a single image
  const runLabel = async (idx: number) => {
    if (!files[idx]) return;
    setLoading(true);
    setLoadingMsg(`Labeling ${files[idx].name}...`);
    setSelectedImage(idx);

    const form = new FormData();
    form.append("image", files[idx]);
    form.append("queries", description);
    form.append("backend", labelBackend);

    try {
      const res = await fetch(`${DLF_API}?path=/api/label`, {
        method: "POST",
        body: form,
      });
      const data: LabelResult = await res.json();
      setLabelResults((prev) => new Map(prev).set(files[idx].name, data));
      drawAnnotations(idx, data);
    } catch (e: any) {
      console.error(e);
    }
    setLoading(false);
    setLoadingMsg("");
  };

  // Ask AI — runs BOTH question answering AND bbox detection in parallel
  const askAI = async () => {
    if (selectedImage === null || !files[selectedImage] || !description) return;
    setLoading(true);
    setLoadingMsg("Asking AI + detecting objects...");
    setAskAnswer(null);

    const file = files[selectedImage];

    // Run ask + label in parallel
    const askForm = new FormData();
    askForm.append("image", file);
    askForm.append("question", description);
    askForm.append("backend", filterBackend);

    const labelForm = new FormData();
    labelForm.append("image", file);
    labelForm.append("queries", description.replace(/\?/g, "").replace(/how many /gi, ""));
    labelForm.append("backend", labelBackend);

    const [askRes, labelRes] = await Promise.allSettled([
      fetch(`${DLF_API}?path=/api/ask`, { method: "POST", body: askForm }).then(r => r.json()),
      fetch(`${DLF_API}?path=/api/label`, { method: "POST", body: labelForm }).then(r => r.json()),
    ]);

    // Process ask result
    if (askRes.status === "fulfilled") {
      const data = askRes.value;
      setAskAnswer(data.answer || data.error || "No response");
      setAskElapsed(data.elapsed || 0);
    } else {
      setAskAnswer(`Error: ${askRes.reason}`);
    }

    // Process label result — draw bboxes
    if (labelRes.status === "fulfilled" && labelRes.value.annotations) {
      const data = labelRes.value as LabelResult;
      setLabelResults((prev) => new Map(prev).set(file.name, data));
      drawAnnotations(selectedImage, data);
    }

    setLoading(false);
    setLoadingMsg("");
  };

  // Draw bboxes on canvas
  const drawAnnotations = (idx: number, result: LabelResult) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      const scale = Math.min(800 / img.width, 600 / img.height, 1);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      result.annotations.forEach((ann, i) => {
        const [x, y, w, h] = ann.bbox;
        const sx = scale;
        const color = BBOX_COLORS[i % BBOX_COLORS.length];

        // Box
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(x * sx, y * sx, w * sx, h * sx);

        // Label bg
        const label = `${ann.category} ${(ann.score * 100).toFixed(0)}%`;
        ctx.font = "bold 14px monospace";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = color;
        ctx.fillRect(x * sx, y * sx - 20, tw + 8, 20);

        // Label text
        ctx.fillStyle = "#fff";
        ctx.fillText(label, x * sx + 4, y * sx - 5);

        // Failed rules indicator
        if (ann.failed_rules && ann.failed_rules.length > 0) {
          ctx.strokeStyle = "#ff0000";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(x * sx - 2, y * sx - 2, w * sx + 4, h * sx + 4);
          ctx.setLineDash([]);
        }
      });
    };
    img.src = previews[idx];
  };

  // Re-draw when selecting an already-labeled image
  useEffect(() => {
    if (selectedImage !== null && files[selectedImage]) {
      const result = labelResults.get(files[selectedImage].name);
      if (result) drawAnnotations(selectedImage, result);
    }
  }, [selectedImage]);

  const aliveFilterBackends = providers.filter(
    (p) => p.alive && p.capabilities.includes("filter")
  );
  const aliveLabelBackends = providers.filter(
    (p) => p.alive && p.capabilities.includes("label")
  );

  const yesCount = filterResults.filter((r) => r.verdict === "YES").length;
  const noCount = filterResults.filter((r) => r.verdict === "NO").length;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Nav */}
      <nav className="fixed top-0 z-50 w-full border-b border-white/5 bg-zinc-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-black">DLF</div>
            <span className="text-sm font-semibold tracking-tight">Data Label Factory</span>
          </Link>
          <div className="hidden items-center gap-8 text-sm text-zinc-400 sm:flex">
            <Link href="/build" className="transition hover:text-white">Build</Link>
            <Link href="/train" className="transition hover:text-white">Train</Link>
            <Link href="/label" className="text-white">Label</Link>
            <Link href="/deploy" className="transition hover:text-white">Deploy</Link>
            <Link href="/pricing" className="transition hover:text-white">Pricing</Link>
            <a href="https://github.com/walter-grace/data-label-factory" target="_blank" className="transition hover:text-white">GitHub</a>
          </div>
          <Link href="/build" className="rounded-lg bg-white px-4 py-1.5 text-sm font-medium text-zinc-900 transition hover:bg-zinc-200">Get Started</Link>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto p-6 pt-20">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Label Images
            </h1>
            <p className="text-zinc-400 text-sm mt-1">
              Upload images, describe your target, pick a model, get labels.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div
              className={`w-3 h-3 rounded-full ${
                apiStatus === "up"
                  ? "bg-emerald-500"
                  : apiStatus === "down"
                  ? "bg-red-500"
                  : "bg-yellow-500 animate-pulse"
              }`}
            />
            <span className="text-sm text-zinc-500">
              {apiStatus === "up"
                ? "API connected"
                : apiStatus === "down"
                ? "API offline — start: python3 -m data_label_factory.serve"
                : "Checking..."}
            </span>
          </div>
        </div>

        {/* Providers status bar */}
        {providers.length > 0 && (
          <div className="flex gap-2 mb-6 flex-wrap">
            {providers.map((p) => (
              <div
                key={p.name}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono border ${
                  p.alive
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                    : "border-zinc-700 bg-zinc-900 text-zinc-600"
                }`}
              >
                {p.alive ? "\u2713" : "\u2717"} {p.name}{" "}
                <span className="text-zinc-500">
                  [{p.capabilities.join(",")}]
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left panel — Controls */}
          <div className="space-y-4">
            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">
                Target object or question
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. stop signs, fire hydrants, or ask: how many birds?"
                className="w-full px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none"
              />
            </div>

            {/* Upload */}
            <div
              onDrop={onDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-zinc-700 rounded-lg p-8 text-center cursor-pointer hover:border-blue-500/50 transition-colors"
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*"
                onChange={onFilesSelected}
                className="hidden"
              />
              <p className="text-zinc-400">
                {files.length
                  ? `${files.length} images selected`
                  : "Drop images here or click to select"}
              </p>
            </div>

            {/* Backend selectors */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Filter backend
                </label>
                <select
                  value={filterBackend}
                  onChange={(e) => setFilterBackend(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-zinc-900 border border-zinc-700 text-sm"
                >
                  {aliveFilterBackends.length ? (
                    aliveFilterBackends.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="qwen">qwen</option>
                      <option value="gemma">gemma</option>
                      <option value="openrouter">openrouter</option>
                      <option value="chandra">chandra</option>
                    </>
                  )}
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Label backend
                </label>
                <select
                  value={labelBackend}
                  onChange={(e) => setLabelBackend(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-zinc-900 border border-zinc-700 text-sm"
                >
                  {aliveLabelBackends.length ? (
                    aliveLabelBackends.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="falcon">falcon</option>
                      <option value="wilddet3d">wilddet3d</option>
                      <option value="chandra">chandra</option>
                      <option value="flywheel">flywheel</option>
                    </>
                  )}
                </select>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex gap-3">
              <button
                onClick={runFilter}
                disabled={loading || !files.length || !description}
                className="flex-1 px-4 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-lg font-medium transition-colors"
              >
                {loading ? loadingMsg : "Filter All"}
              </button>
              <button
                onClick={askAI}
                disabled={loading || !files.length || !description || selectedImage === null}
                className="flex-1 px-4 py-3 bg-purple-600 hover:bg-purple-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-lg font-medium transition-colors"
              >
                Ask AI
              </button>
            </div>

            {/* Ask AI answer */}
            {askAnswer && (
              <div className="bg-zinc-900 rounded-lg p-4 border border-purple-500/30">
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-purple-400 font-medium">AI Answer</span>
                  <span className="text-zinc-500">{askElapsed}s</span>
                </div>
                <p className="text-zinc-200 text-sm whitespace-pre-wrap">{askAnswer}</p>
              </div>
            )}

            {/* Filter summary */}
            {filterResults.length > 0 && (
              <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-zinc-400">Filter results</span>
                  <span className="text-zinc-500">
                    {filterResults.length} images
                  </span>
                </div>
                <div className="flex gap-4 text-lg font-mono">
                  <span className="text-emerald-400">{yesCount} YES</span>
                  <span className="text-red-400">{noCount} NO</span>
                  <span className="text-zinc-500">
                    {filterResults.length - yesCount - noCount} other
                  </span>
                </div>
                <div className="w-full bg-zinc-800 rounded-full h-2 mt-2">
                  <div
                    className="bg-emerald-500 h-2 rounded-full transition-all"
                    style={{
                      width: `${(yesCount / Math.max(filterResults.length, 1)) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Center panel — Image grid + filter results */}
          <div className="space-y-2 max-h-[80vh] overflow-y-auto">
            {previews.map((src, i) => {
              const fr = filterResults[i];
              const lr = labelResults.get(files[i]?.name);
              return (
                <div
                  key={i}
                  onClick={() => {
                    setSelectedImage(i);
                    if (lr) drawAnnotations(i, lr);
                  }}
                  className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ${
                    selectedImage === i
                      ? "bg-zinc-800 border border-blue-500/50"
                      : "bg-zinc-900/50 border border-zinc-800 hover:bg-zinc-800/50"
                  }`}
                >
                  <img
                    src={src}
                    alt=""
                    className="w-16 h-16 object-cover rounded"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-300 truncate">
                      {files[i]?.name}
                    </p>
                    {fr && (
                      <div className="flex items-center gap-2 mt-1">
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-mono border ${
                            VERDICT_COLORS[fr.verdict] || VERDICT_COLORS.UNKNOWN
                          }`}
                        >
                          {fr.verdict}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {fr.elapsed}s
                        </span>
                      </div>
                    )}
                    {lr && (
                      <p className="text-xs text-zinc-500 mt-0.5">
                        {lr.n_detections} detections via {lr.backend}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      runLabel(i);
                    }}
                    disabled={loading}
                    className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 rounded"
                  >
                    Label
                  </button>
                </div>
              );
            })}
            {previews.length === 0 && (
              <div className="text-center text-zinc-600 py-20">
                Upload images to get started
              </div>
            )}
          </div>

          {/* Right panel — Canvas + annotations */}
          <div className="space-y-4">
            <canvas
              ref={canvasRef}
              className="w-full rounded-lg bg-zinc-900 border border-zinc-800"
              width={800}
              height={600}
            />

            {selectedImage !== null && files[selectedImage] && (
              <div>
                {(() => {
                  const lr = labelResults.get(files[selectedImage].name);
                  if (!lr) return null;
                  return (
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-zinc-400">
                          {lr.n_detections} detections
                        </span>
                        <span className="text-zinc-500">
                          {lr.elapsed}s via {lr.backend}
                        </span>
                      </div>
                      {lr.annotations.map((ann, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-2 px-3 py-2 bg-zinc-900 rounded border border-zinc-800 text-sm"
                        >
                          <div
                            className="w-3 h-3 rounded-full flex-shrink-0"
                            style={{
                              backgroundColor:
                                BBOX_COLORS[i % BBOX_COLORS.length],
                            }}
                          />
                          <span className="font-mono text-zinc-300">
                            {ann.category}
                          </span>
                          <span className="text-zinc-500">
                            {(ann.score * 100).toFixed(0)}%
                          </span>
                          <span className="text-zinc-600 text-xs ml-auto">
                            [{ann.bbox.map((v) => Math.round(v)).join(", ")}]
                          </span>
                          {ann.pass_rate !== undefined && (
                            <span
                              className={`text-xs px-1.5 py-0.5 rounded ${
                                ann.pass_rate >= 1
                                  ? "bg-emerald-500/20 text-emerald-400"
                                  : "bg-yellow-500/20 text-yellow-400"
                              }`}
                            >
                              {(ann.pass_rate * 100).toFixed(0)}%
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {!labelResults.get(files[selectedImage].name) && (
                  <div className="text-center text-zinc-600 py-8">
                    Click "Label" on an image to see detections
                  </div>
                )}
              </div>
            )}

            {selectedImage === null && (
              <div className="text-center text-zinc-600 py-8">
                Select an image to view / label
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-zinc-800/50 py-8 mt-12">
        <div className="mx-auto max-w-5xl px-6 flex flex-col items-center justify-between gap-4 text-sm text-zinc-500 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-[8px] font-black text-white">DLF</div>
            <span>Data Label Factory</span>
          </div>
          <div className="flex gap-6">
            <Link href="/build" className="transition hover:text-zinc-300">Build</Link>
            <Link href="/train" className="transition hover:text-zinc-300">Train</Link>
            <Link href="/deploy" className="transition hover:text-zinc-300">Deploy</Link>
            <Link href="/pricing" className="transition hover:text-zinc-300">Pricing</Link>
            <a href="https://github.com/walter-grace/data-label-factory" target="_blank" className="transition hover:text-zinc-300">GitHub</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
