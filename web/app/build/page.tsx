"use client";

import { useState, useCallback, useRef, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import Link from "next/link";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type ImageItem = {
  file: File;
  url: string;
  name: string;
  filterResult?: { verdict: string; raw_answer: string; elapsed: number; confidence: number };
  labelResult?: { annotations: any[]; elapsed: number; n_detections: number; image_size: number[] };
  status: "pending" | "filtering" | "labeling" | "done" | "error";
  error?: string;
};

type Step = "input" | "processing" | "results";

/* ------------------------------------------------------------------ */
/* API helper                                                          */
/* ------------------------------------------------------------------ */

const DLF_PROXY = "/api/dlf";

async function dlfPost(endpoint: string, formData: FormData) {
  const res = await fetch(`${DLF_PROXY}?path=${endpoint}`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

function BuildPageInner() {
  const searchParams = useSearchParams();
  const [step, setStep] = useState<Step>("input");
  const [target, setTarget] = useState(searchParams.get("target") || "");
  const [images, setImages] = useState<ImageItem[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [urlLoading, setUrlLoading] = useState(false);
  const [backend, setBackend] = useState("openrouter");       // Gemma 4 for filter/verify
  const [labelBackend, setLabelBackend] = useState("falcon"); // Falcon for precise bboxes
  const [useBatch, setUseBatch] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, stage: "" });
  const [selectedImg, setSelectedImg] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [providers, setProviders] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedJobId, setSavedJobId] = useState<string | null>(null);
  const [training, setTraining] = useState(false);
  const [trainResult, setTrainResult] = useState<any>(null);

  // Fetch providers
  useEffect(() => {
    fetch(`${DLF_PROXY}?path=/api/providers`)
      .then((r) => r.json())
      .then((d) => setProviders(d.providers ?? []))
      .catch(() => {});
  }, []);

  const aliveProviders = providers.filter((p) => p.alive);
  const filterProviders = aliveProviders.filter((p) => p.capabilities?.includes("filter"));
  const labelProviders = aliveProviders.filter((p) => p.capabilities?.includes("label"));

  /* ---- File handling ---- */

  const addFiles = useCallback((files: FileList | File[]) => {
    const newItems: ImageItem[] = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .map((f) => ({
        file: f,
        url: URL.createObjectURL(f),
        name: f.name,
        status: "pending" as const,
      }));
    setImages((prev) => [...prev, ...newItems]);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const removeImage = (idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  };

  /* ---- URL import ---- */

  const importFromUrl = async () => {
    if (!urlInput.trim()) return;
    setUrlLoading(true);
    try {
      // Try to fetch image directly
      const res = await fetch(urlInput);
      const ct = res.headers.get("content-type") || "";
      if (ct.startsWith("image/")) {
        const blob = await res.blob();
        const fname = urlInput.split("/").pop() || "imported.jpg";
        const file = new File([blob], fname, { type: blob.type });
        addFiles([file]);
        setUrlInput("");
        toast.success("Image imported");
      } else {
        toast.error("URL does not point to an image. Try a direct image URL (.jpg, .png, etc.)");
      }
    } catch (e: any) {
      toast.error(`Import failed: ${e.message}`);
    } finally {
      setUrlLoading(false);
    }
  };

  /* ---- Pipeline ---- */

  const runPipeline = async () => {
    if (!target.trim()) {
      toast.error("Enter what you want to detect");
      return;
    }
    if (images.length === 0) {
      toast.error("Add at least one image");
      return;
    }

    setStep("processing");
    setProcessing(true);

    const total = images.length;

    if (useBatch && images.length >= 2) {
      // ── Batch mode: send all images at once, parallel filter+label ──
      setProgress({ current: 0, total, stage: "Batch processing" });
      setImages((prev) => prev.map((item) => ({ ...item, status: "filtering" })));

      try {
        const batchForm = new FormData();
        for (const img of images) {
          batchForm.append("images", img.file);
        }
        batchForm.append("target", target);
        batchForm.append("queries", target);
        batchForm.append("backend", backend);
        batchForm.append("label_backend", labelBackend);

        const batchResult = await dlfPost("/api/batch-label", batchForm);

        // Map batch results back to our image state
        setImages((prev) =>
          prev.map((item) => {
            const r = batchResult.results?.find((br: any) => br.name === item.name);
            if (!r) return { ...item, status: "done" };
            return {
              ...item,
              filterResult: r.filter,
              labelResult: r.label || undefined,
              status: "done",
            };
          })
        );

        setProgress({ current: total, total, stage: "Done" });
      } catch (e: any) {
        setImages((prev) =>
          prev.map((item) => ({ ...item, status: "error", error: e.message }))
        );
      }
    } else {
      // ── Sequential mode: one at a time with live progress ──
      for (let i = 0; i < images.length; i++) {
        const img = images[i];

        // Stage 1: Filter
        setProgress({ current: i + 1, total, stage: "Filtering" });
        setImages((prev) =>
          prev.map((item, idx) => (idx === i ? { ...item, status: "filtering" } : item))
        );

        try {
          const filterForm = new FormData();
          filterForm.append("image", img.file);
          filterForm.append(
            "prompt",
            `Look at this image. Does it show a ${target}? Answer with exactly one word: YES or NO.`
          );
          filterForm.append("backend", backend);

          const filterResult = await dlfPost("/api/filter", filterForm);

          setImages((prev) =>
            prev.map((item, idx) =>
              idx === i ? { ...item, filterResult } : item
            )
          );

          // Stage 2: Label (only YES images)
          if (filterResult.verdict === "YES") {
            setProgress({ current: i + 1, total, stage: "Labeling" });
            setImages((prev) =>
              prev.map((item, idx) =>
                idx === i ? { ...item, status: "labeling" } : item
              )
            );

            const labelForm = new FormData();
            labelForm.append("image", img.file);
            labelForm.append("queries", target);
            labelForm.append("backend", labelBackend);

            const labelResult = await dlfPost("/api/label", labelForm);

            setImages((prev) =>
              prev.map((item, idx) =>
                idx === i
                  ? { ...item, labelResult, status: "done" }
                  : item
              )
            );
          } else {
            setImages((prev) =>
              prev.map((item, idx) =>
                idx === i ? { ...item, status: "done" } : item
              )
            );
          }
        } catch (e: any) {
          setImages((prev) =>
            prev.map((item, idx) =>
              idx === i ? { ...item, status: "error", error: e.message } : item
            )
          );
        }
      }
    }

    setProcessing(false);
    setStep("results");
    toast.success("Pipeline complete!");
  };

  /* ---- Build COCO JSON ---- */

  const buildCoco = () => {
    const yesImages = images.filter((i) => i.filterResult?.verdict === "YES" && i.labelResult);
    return {
      images: yesImages.map((img, i) => ({
        id: i,
        file_name: img.name,
        width: img.labelResult!.image_size[0],
        height: img.labelResult!.image_size[1],
      })),
      annotations: yesImages.flatMap((img, imgIdx) =>
        (img.labelResult!.annotations ?? []).map((ann: any, annIdx: number) => ({
          id: imgIdx * 1000 + annIdx,
          image_id: imgIdx,
          category_id: 0,
          bbox: ann.bbox,
          area: ann.bbox[2] * ann.bbox[3],
          iscrowd: 0,
          score: ann.score,
        }))
      ),
      categories: [{ id: 0, name: target }],
    };
  };

  /* ---- Save to R2 ---- */

  const saveToR2 = async () => {
    setSaving(true);
    try {
      const jobId = `${target.replace(/\s+/g, "-")}_${Date.now()}`;
      const coco = buildCoco();
      const yesImages = images.filter((i) => i.filterResult?.verdict === "YES" && i.labelResult);

      const form = new FormData();
      form.append("meta", JSON.stringify({
        jobId,
        target,
        backend,
        labelBackend,
        results: images.map((i) => ({
          name: i.name,
          filter: i.filterResult?.verdict,
          detections: i.labelResult?.n_detections ?? 0,
        })),
      }));
      form.append("coco", JSON.stringify(coco));

      for (const img of yesImages) {
        form.append("images", img.file);
      }

      const res = await fetch("/api/jobs", { method: "POST", body: form });
      const data = await res.json();

      if (data.saved) {
        setSavedJobId(jobId);
        toast.success(`Saved to cloud: ${data.n_images} images, ${data.n_annotations} annotations`);
      } else if (data.error === "R2 not configured") {
        toast.error("R2 storage not configured. Set R2 credentials in .env.local to enable cloud saves.");
      } else {
        toast.error(data.error || "Save failed");
      }
    } catch (e: any) {
      toast.error(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  /* ---- Train YOLO model ---- */

  const trainModel = async () => {
    setTraining(true);
    try {
      const coco = buildCoco();
      const yesImages = images.filter((i) => i.filterResult?.verdict === "YES" && i.labelResult);

      const form = new FormData();
      form.append("coco_file", new Blob([JSON.stringify(coco)], { type: "application/json" }), "coco.json");
      for (const img of yesImages) {
        form.append("images", img.file);
      }
      form.append("target", target);
      form.append("epochs", "50");
      form.append("model_base", "yolo11n.pt");

      const result = await dlfPost("/api/train", form);
      setTrainResult(result);

      if (result.status === "complete") {
        toast.success(`Model trained in ${result.elapsed}s!`);
      } else if (result.status === "dataset_ready") {
        toast.success("YOLO dataset exported — download to train locally");
      } else {
        toast.error(result.error || "Training failed");
      }
    } catch (e: any) {
      toast.error(`Training failed: ${e.message}`);
      setTrainResult({ status: "error", error: e.message });
    } finally {
      setTraining(false);
    }
  };

  /* ---- Stats ---- */

  const yesCount = images.filter((i) => i.filterResult?.verdict === "YES").length;
  const noCount = images.filter((i) => i.filterResult?.verdict === "NO").length;
  const totalDetections = images.reduce(
    (sum, i) => sum + (i.labelResult?.n_detections ?? 0),
    0
  );
  const doneCount = images.filter((i) => i.status === "done").length;
  const errorCount = images.filter((i) => i.status === "error").length;

  /* ---- Render ---- */

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <Toaster theme="dark" position="bottom-right" />

      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-zinc-400 hover:text-zinc-200 transition" aria-label="Back to home">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
              </svg>
            </Link>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Build Dataset</h1>
              <p className="text-sm text-zinc-500">
                {step === "input" && "Describe your target and add images"}
                {step === "processing" && `Processing ${progress.current}/${progress.total}...`}
                {step === "results" && `Done — ${yesCount} matches, ${totalDetections} bounding boxes`}
              </p>
            </div>
          </div>

          {/* Step indicators */}
          <div className="flex items-center gap-2">
            {["input", "processing", "results"].map((s, i) => (
              <div key={s} className="flex items-center gap-2">
                <div
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                    step === s
                      ? "bg-blue-600 text-white"
                      : ["input", "processing", "results"].indexOf(step) > i
                      ? "bg-emerald-600 text-white"
                      : "bg-zinc-800 text-zinc-500"
                  }`}
                >
                  {["input", "processing", "results"].indexOf(step) > i ? (
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </div>
                {i < 2 && <div className="h-px w-8 bg-zinc-700" />}
              </div>
            ))}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl p-6">
        {/* ==================== STEP 1: INPUT ==================== */}
        {step === "input" && (
          <div className="grid gap-6 lg:grid-cols-3">
            {/* Left: Config */}
            <div className="space-y-6">
              {/* Target */}
              <Card className="bg-zinc-900/30 border-zinc-800">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">What do you want to detect?</CardTitle>
                </CardHeader>
                <CardContent>
                  <input
                    type="text"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    placeholder="e.g. fire hydrants, stop signs, birds..."
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-zinc-100 placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </CardContent>
              </Card>

              {/* Mode Presets */}
              <Card className="bg-zinc-900/30 border-zinc-800">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Pipeline Mode</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <button
                    onClick={() => { setBackend("openrouter"); setLabelBackend("falcon"); }}
                    className={`w-full rounded-xl border p-3 text-left transition ${
                      backend === "openrouter" && labelBackend === "falcon"
                        ? "border-blue-500 bg-blue-950/30"
                        : "border-zinc-700 bg-zinc-800/50 hover:border-zinc-600"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold">Flywheel Mode</span>
                      <Badge variant="outline" className="border-blue-700 text-blue-400 text-[10px]">Best Quality</Badge>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1">
                      Gemma 4 filters + Falcon labels + Gemma verifies
                    </p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">
                      ~12s/image — two models reinforcing each other
                    </p>
                  </button>

                  <button
                    onClick={() => { setBackend("openrouter"); setLabelBackend("openrouter"); }}
                    className={`w-full rounded-xl border p-3 text-left transition ${
                      backend === "openrouter" && labelBackend === "openrouter"
                        ? "border-blue-500 bg-blue-950/30"
                        : "border-zinc-700 bg-zinc-800/50 hover:border-zinc-600"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold">Fast Mode</span>
                      <Badge variant="outline" className="border-blue-700 text-blue-400 text-[10px]">Fastest</Badge>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1">
                      Gemma 4 does everything — filter, label, verify
                    </p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">
                      ~2s/image — cloud only, no local GPU needed
                    </p>
                  </button>

                  {/* Advanced toggle */}
                  <details className="group pt-1">
                    <summary className="flex items-center gap-1.5 text-[11px] text-zinc-500 cursor-pointer hover:text-zinc-300 list-none [&::-webkit-details-marker]:hidden">
                      <svg className="h-3 w-3 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                      </svg>
                      Advanced — pick backends manually
                    </summary>
                    <div className="space-y-2 pt-2 pl-[18px]">
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">Filter + Verify</label>
                        <select
                          value={backend}
                          onChange={(e) => setBackend(e.target.value)}
                          className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"
                        >
                          {filterProviders.map((p) => (
                            <option key={p.name} value={p.name}>{p.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">Labeling (bboxes)</label>
                        <select
                          value={labelBackend}
                          onChange={(e) => setLabelBackend(e.target.value)}
                          className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"
                        >
                          {labelProviders.map((p) => (
                            <option key={p.name} value={p.name}>{p.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </details>

                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="checkbox"
                      id="batch-mode"
                      checked={useBatch}
                      onChange={(e) => setUseBatch(e.target.checked)}
                      className="rounded border-zinc-600"
                    />
                    <label htmlFor="batch-mode" className="text-xs text-zinc-400">
                      Parallel processing (faster for 2+ images)
                    </label>
                  </div>
                </CardContent>
              </Card>

              {/* Import URL */}
              <Card className="bg-zinc-900/30 border-zinc-800">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Import from URL</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      placeholder="Paste image URL..."
                      className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none"
                      onKeyDown={(e) => e.key === "Enter" && importFromUrl()}
                    />
                    <Button
                      onClick={importFromUrl}
                      disabled={urlLoading}
                      size="sm"
                      className="bg-zinc-700 hover:bg-zinc-600"
                    >
                      {urlLoading ? "..." : "Add"}
                    </Button>
                  </div>
                  <p className="mt-2 text-[11px] text-zinc-500">
                    Direct image URL, Roboflow export link, or any .jpg/.png URL
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Right: Image upload + grid */}
            <div className="lg:col-span-2 space-y-4">
              {/* Drop zone */}
              <div
                ref={dropRef}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 transition ${
                  dragOver
                    ? "border-blue-500 bg-blue-950/20"
                    : "border-zinc-700 bg-zinc-900/50 hover:border-zinc-600 hover:bg-zinc-900"
                }`}
              >
                <svg className="h-10 w-10 text-zinc-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
                </svg>
                <p className="mt-3 text-sm text-zinc-400">
                  Drop images here or <span className="text-blue-400">click to browse</span>
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  JPG, PNG, WebP — any number of images
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => e.target.files && addFiles(e.target.files)}
                />
              </div>

              {/* Image grid */}
              {images.length > 0 && (
                <div className="grid grid-cols-4 gap-3 sm:grid-cols-5 md:grid-cols-6">
                  {images.map((img, idx) => (
                    <div
                      key={idx}
                      className="group relative aspect-square overflow-hidden rounded-lg border border-zinc-800"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.url}
                        alt={img.name}
                        className="h-full w-full object-cover"
                      />
                      <button
                        onClick={(e) => { e.stopPropagation(); removeImage(idx); }}
                        className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-xs text-zinc-300 opacity-0 transition group-hover:opacity-100 hover:bg-red-600"
                      >
                        x
                      </button>
                      <div className="absolute bottom-0 inset-x-0 bg-black/60 px-1.5 py-0.5 text-[10px] text-zinc-300 truncate">
                        {img.name}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Run button */}
              <div className="flex items-center justify-between pt-4">
                <span className="text-sm text-zinc-400">
                  {images.length} image{images.length !== 1 ? "s" : ""} ready
                </span>
                <Button
                  onClick={runPipeline}
                  disabled={!target.trim() || images.length === 0}
                  className="bg-blue-600 hover:bg-blue-500 rounded-xl px-8 h-11 text-base font-semibold shadow-lg shadow-blue-600/25"
                >
                  Run Pipeline
                  <svg className="ml-2 h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ==================== STEP 2: PROCESSING ==================== */}
        {step === "processing" && (
          <div className="space-y-6">
            {/* Progress bar */}
            <Card className="bg-zinc-900 border-zinc-800">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium">
                    {progress.stage} image {progress.current} of {progress.total}
                  </span>
                  <span className="text-sm text-zinc-400">
                    {target}
                  </span>
                </div>
                <div className="h-3 w-full rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all duration-300"
                    style={{ width: `${(progress.current / Math.max(progress.total, 1)) * 100}%` }}
                  />
                </div>
                <div className="mt-4 grid grid-cols-4 gap-4 text-center text-sm">
                  <div>
                    <div className="text-lg font-bold">{doneCount}</div>
                    <div className="text-zinc-500">Done</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-emerald-400">{yesCount}</div>
                    <div className="text-zinc-500">Matches</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-red-400">{noCount}</div>
                    <div className="text-zinc-500">Rejected</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-blue-400">{totalDetections}</div>
                    <div className="text-zinc-500">Bboxes</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Image results grid */}
            <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5">
              {images.map((img, idx) => (
                <div
                  key={idx}
                  className={`relative aspect-square overflow-hidden rounded-lg border-2 ${
                    img.status === "filtering" || img.status === "labeling"
                      ? "border-blue-500 ring-2 ring-blue-500/30"
                      : img.filterResult?.verdict === "YES"
                      ? "border-emerald-500"
                      : img.filterResult?.verdict === "NO"
                      ? "border-red-500/50"
                      : img.status === "error"
                      ? "border-red-600"
                      : "border-zinc-800"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt="" className="h-full w-full object-cover" />

                  {/* Status overlay */}
                  {(img.status === "filtering" || img.status === "labeling") && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <div className="flex flex-col items-center gap-2">
                        <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                        <span className="text-xs text-blue-300">
                          {img.status === "filtering" ? "Filtering..." : "Labeling..."}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Result badge */}
                  {img.filterResult && (
                    <div className="absolute top-1.5 left-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          img.filterResult.verdict === "YES"
                            ? "bg-emerald-600 text-white"
                            : "bg-red-600/80 text-white"
                        }`}
                      >
                        {img.filterResult.verdict}
                      </span>
                    </div>
                  )}

                  {/* Detection count */}
                  {img.labelResult && img.labelResult.n_detections > 0 && (
                    <div className="absolute top-1.5 right-1.5">
                      <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                        {img.labelResult.n_detections} bbox
                      </span>
                    </div>
                  )}

                  {/* Bottom bar */}
                  <div className="absolute bottom-0 inset-x-0 bg-black/60 px-1.5 py-1 text-[10px] text-zinc-300 truncate">
                    {img.name}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ==================== STEP 3: RESULTS ==================== */}
        {step === "results" && (
          <div className="space-y-6">
            {/* Summary */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              <Card className="bg-zinc-900/30 border-zinc-800">
                <CardContent className="pt-4 pb-4 text-center">
                  <div className="text-2xl font-bold">{images.length}</div>
                  <div className="text-xs text-zinc-500">Total Images</div>
                </CardContent>
              </Card>
              <Card className="bg-zinc-900/30 border-zinc-800">
                <CardContent className="pt-4 pb-4 text-center">
                  <div className="text-2xl font-bold text-emerald-400">{yesCount}</div>
                  <div className="text-xs text-zinc-500">Matches</div>
                </CardContent>
              </Card>
              <Card className="bg-zinc-900/30 border-zinc-800">
                <CardContent className="pt-4 pb-4 text-center">
                  <div className="text-2xl font-bold text-red-400">{noCount}</div>
                  <div className="text-xs text-zinc-500">Rejected</div>
                </CardContent>
              </Card>
              <Card className="bg-zinc-900/30 border-zinc-800">
                <CardContent className="pt-4 pb-4 text-center">
                  <div className="text-2xl font-bold text-blue-400">{totalDetections}</div>
                  <div className="text-xs text-zinc-500">Bounding Boxes</div>
                </CardContent>
              </Card>
              <Card className="bg-zinc-900/30 border-zinc-800">
                <CardContent className="pt-4 pb-4 text-center">
                  <div className="text-2xl font-bold text-amber-400">{errorCount}</div>
                  <div className="text-xs text-zinc-500">Errors</div>
                </CardContent>
              </Card>
            </div>

            {/* Image detail view */}
            <div className="grid gap-6 lg:grid-cols-3">
              {/* Thumbnail strip */}
              <div className="max-h-[600px] overflow-y-auto space-y-2 pr-2">
                {images.map((img, idx) => (
                  <button
                    key={idx}
                    onClick={() => setSelectedImg(idx)}
                    className={`flex w-full items-center gap-3 rounded-lg border p-2 text-left transition ${
                      selectedImg === idx
                        ? "border-blue-500 bg-zinc-800"
                        : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt=""
                      className="h-12 w-12 rounded object-cover"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs truncate">{img.name}</div>
                      <div className="flex gap-2 mt-1">
                        {img.filterResult && (
                          <Badge
                            variant="outline"
                            className={`text-[10px] py-0 ${
                              img.filterResult.verdict === "YES"
                                ? "border-emerald-700 text-emerald-400"
                                : "border-red-700 text-red-400"
                            }`}
                          >
                            {img.filterResult.verdict}
                          </Badge>
                        )}
                        {img.labelResult && (
                          <Badge
                            variant="outline"
                            className="text-[10px] py-0 border-blue-700 text-blue-400"
                          >
                            {img.labelResult.n_detections} det
                          </Badge>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              {/* Selected image detail */}
              <div className="lg:col-span-2">
                {images[selectedImg] && (
                  <Card className="bg-zinc-900/30 border-zinc-800">
                    <CardContent className="pt-6">
                      <div className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={images[selectedImg].url}
                          alt=""
                          className="w-full rounded-lg"
                        />
                        {/* Draw bboxes */}
                        {images[selectedImg].labelResult?.annotations?.map(
                          (ann: any, i: number) => {
                            const imgSize = images[selectedImg].labelResult!.image_size;
                            if (!imgSize) return null;
                            const [iw, ih] = imgSize;
                            const [bx, by, bw, bh] = ann.bbox;
                            return (
                              <div
                                key={i}
                                className="absolute border-2 border-emerald-400 rounded-sm"
                                style={{
                                  left: `${(bx / iw) * 100}%`,
                                  top: `${(by / ih) * 100}%`,
                                  width: `${(bw / iw) * 100}%`,
                                  height: `${(bh / ih) * 100}%`,
                                }}
                              >
                                <span className="absolute -top-5 left-0 rounded bg-emerald-600 px-1 py-0.5 text-[9px] font-bold text-white whitespace-nowrap">
                                  {ann.category || target}{" "}
                                  {ann.score ? `${Math.round(ann.score * 100)}%` : ""}
                                </span>
                              </div>
                            );
                          }
                        )}
                      </div>

                      {/* Details */}
                      <div className="mt-4 space-y-3">
                        <h3 className="font-semibold">{images[selectedImg].name}</h3>

                        {images[selectedImg].filterResult && (
                          <div className="rounded bg-zinc-800 px-3 py-2 text-sm">
                            <span className="text-zinc-400">Filter: </span>
                            <span
                              className={
                                images[selectedImg].filterResult!.verdict === "YES"
                                  ? "text-emerald-400 font-bold"
                                  : "text-red-400 font-bold"
                              }
                            >
                              {images[selectedImg].filterResult!.verdict}
                            </span>
                            <span className="text-zinc-500 ml-2">
                              ({images[selectedImg].filterResult!.elapsed}s)
                            </span>
                            {images[selectedImg].filterResult!.raw_answer && (
                              <div className="text-xs text-zinc-500 mt-1">
                                {images[selectedImg].filterResult!.raw_answer}
                              </div>
                            )}
                          </div>
                        )}

                        {images[selectedImg].labelResult && (
                          <div className="rounded bg-zinc-800 px-3 py-2 text-sm">
                            <span className="text-zinc-400">Labels: </span>
                            <span className="text-blue-400 font-bold">
                              {images[selectedImg].labelResult!.n_detections} detections
                            </span>
                            <span className="text-zinc-500 ml-2">
                              ({images[selectedImg].labelResult!.elapsed}s)
                            </span>
                            {images[selectedImg].labelResult!.annotations?.map(
                              (ann: any, i: number) => (
                                <div key={i} className="text-xs text-zinc-500 mt-1">
                                  bbox: [{ann.bbox.map((v: number) => Math.round(v)).join(", ")}]
                                  {ann.pass_rate !== undefined && (
                                    <span className={ann.pass_rate >= 0.7 ? "text-emerald-400" : "text-amber-400"}>
                                      {" "}quality: {Math.round(ann.pass_rate * 100)}%
                                    </span>
                                  )}
                                </div>
                              )
                            )}
                          </div>
                        )}

                        {images[selectedImg].error && (
                          <div className="rounded bg-red-950 px-3 py-2 text-sm text-red-300">
                            Error: {images[selectedImg].error}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3 pt-4">
              <Button
                onClick={() => {
                  setStep("input");
                  setSavedJobId(null);
                  setImages((prev) =>
                    prev.map((i) => ({ ...i, status: "pending" as const, filterResult: undefined, labelResult: undefined, error: undefined }))
                  );
                }}
                variant="outline"
                className="border-zinc-700"
              >
                Start Over
              </Button>
              <Button
                onClick={() => {
                  const coco = buildCoco();
                  const blob = new Blob([JSON.stringify(coco, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${target.replace(/\s+/g, "_")}_coco.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                  toast.success("COCO JSON downloaded");
                }}
                className="bg-emerald-600 hover:bg-emerald-500"
                disabled={totalDetections === 0}
              >
                Download COCO JSON ({totalDetections} bboxes)
              </Button>
              <Button
                onClick={saveToR2}
                disabled={totalDetections === 0 || saving || !!savedJobId}
                className="bg-blue-600 hover:bg-blue-500"
              >
                {saving ? (
                  <>
                    <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Saving...
                  </>
                ) : savedJobId ? (
                  "Saved to Cloud"
                ) : (
                  "Save to Cloud (R2)"
                )}
              </Button>
              <Button
                onClick={trainModel}
                disabled={totalDetections === 0 || training || !!trainResult}
                className="bg-blue-600 hover:bg-blue-500"
              >
                {training ? (
                  <>
                    <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Training YOLO...
                  </>
                ) : trainResult?.status === "complete" ? (
                  "Model Ready"
                ) : (
                  "Train YOLO Model"
                )}
              </Button>
            </div>

            {/* Train result */}
            {trainResult && (
              <Card className={`border ${
                trainResult.status === "complete"
                  ? "bg-blue-950/30 border-blue-700"
                  : trainResult.status === "dataset_ready"
                  ? "bg-zinc-900 border-zinc-700"
                  : "bg-red-950/30 border-red-700"
              }`}>
                <CardContent className="pt-4 pb-4">
                  {trainResult.status === "complete" && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-blue-400">Model trained!</span>
                        <span className="text-sm text-zinc-400">{trainResult.elapsed}s</span>
                      </div>
                      <p className="text-sm text-zinc-400">
                        {trainResult.epochs} epochs on {trainResult.n_images} images ({trainResult.n_annotations} bboxes)
                      </p>
                      <Button
                        onClick={() => {
                          window.open(
                            `/api/dlf?path=/api/train/${trainResult.job_id}/model`,
                            "_blank"
                          );
                        }}
                        className="bg-blue-600 hover:bg-blue-500"
                      >
                        Download best.pt
                      </Button>
                    </div>
                  )}
                  {trainResult.status === "dataset_ready" && (
                    <div className="space-y-2">
                      <span className="font-semibold text-zinc-300">YOLO dataset exported</span>
                      <p className="text-sm text-zinc-400">{trainResult.message}</p>
                    </div>
                  )}
                  {trainResult.status === "error" && (
                    <div className="space-y-1">
                      <span className="font-semibold text-red-400">Training failed</span>
                      <p className="text-sm text-red-300">{trainResult.error}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="mt-auto border-t border-zinc-800/50 py-8">
        <div className="mx-auto max-w-5xl px-6 flex flex-col items-center justify-between gap-4 text-sm text-zinc-500 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-[8px] font-black text-white">
              DLF
            </div>
            <span>Data Label Factory</span>
          </div>
          <div className="flex gap-6">
            <Link href="/" className="transition hover:text-zinc-300">Home</Link>
            <Link href="/train" className="transition hover:text-zinc-300">Train</Link>
            <a href="https://github.com/walter-grace/data-label-factory" target="_blank" className="transition hover:text-zinc-300">GitHub</a>
          </div>
        </div>
      </footer>
    </main>
  );
}

export default function BuildPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-zinc-950" />}>
      <BuildPageInner />
    </Suspense>
  );
}
