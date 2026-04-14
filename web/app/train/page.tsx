"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import Link from "next/link";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type TrainStatus = "idle" | "uploading" | "provisioning" | "training" | "complete" | "error";

type TrainJob = {
  jobId: string;
  status: TrainStatus;
  target: string;
  nImages: number;
  nAnnotations: number;
  epochs: number;
  gpu: string;
  modelUrl?: string;
  elapsed?: number;
  error?: string;
  progress?: { epoch: number; total: number; loss?: number };
};

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

export default function TrainPage() {
  const [cocoFile, setCocoFile] = useState<File | null>(null);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [target, setTarget] = useState("");
  const [epochs, setEpochs] = useState(50);
  const [modelBase, setModelBase] = useState("yolo11n.pt");
  const [job, setJob] = useState<TrainJob | null>(null);
  const [polling, setPolling] = useState(false);

  // Poll for training status
  useEffect(() => {
    if (!job || !polling || !job.jobId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${DLF_PROXY}?path=/api/train-status/${job.jobId}`);
        const data = await res.json();
        if (data.status === "complete") {
          setJob((prev) => prev ? { ...prev, status: "complete", modelUrl: data.model_url, elapsed: data.elapsed } : prev);
          setPolling(false);
          toast.success("Model trained!");
        } else if (data.status === "error") {
          setJob((prev) => prev ? { ...prev, status: "error", error: data.error } : prev);
          setPolling(false);
          toast.error("Training failed");
        } else if (data.progress) {
          setJob((prev) => prev ? { ...prev, progress: data.progress, status: "training" } : prev);
        }
      } catch {
        // Polling error — keep trying
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [job, polling]);

  const startTraining = async () => {
    if (!cocoFile) {
      toast.error("Upload a COCO JSON file");
      return;
    }
    if (imageFiles.length === 0) {
      toast.error("Upload training images");
      return;
    }

    const jobId = `train_${Date.now()}`;
    setJob({
      jobId,
      status: "uploading",
      target: target || "object",
      nImages: imageFiles.length,
      nAnnotations: 0,
      epochs,
      gpu: "RTX 4000 Ada",
    });

    try {
      // Send to backend
      setJob((prev) => prev ? { ...prev, status: "uploading" } : prev);
      const form = new FormData();
      form.append("coco_file", cocoFile);
      for (const f of imageFiles) {
        form.append("images", f);
      }
      form.append("target", target || "object");
      form.append("epochs", String(epochs));
      form.append("model_base", modelBase);

      setJob((prev) => prev ? { ...prev, status: "training" } : prev);
      const result = await dlfPost("/api/train", form);

      if (result.status === "complete") {
        setJob((prev) => prev ? {
          ...prev,
          status: "complete",
          elapsed: result.elapsed,
          nAnnotations: result.n_annotations,
          modelUrl: `/api/dlf?path=/api/train/${result.job_id}/model`,
        } : prev);
        toast.success(`Model trained in ${result.elapsed}s!`);
      } else if (result.status === "dataset_ready") {
        setJob((prev) => prev ? {
          ...prev,
          status: "complete",
          nAnnotations: result.n_annotations,
          error: result.message,
        } : prev);
        toast.success("Dataset exported — train locally");
      } else {
        setJob((prev) => prev ? { ...prev, status: "error", error: result.error } : prev);
        toast.error(result.error || "Training failed");
      }
    } catch (e: any) {
      setJob((prev) => prev ? { ...prev, status: "error", error: e.message } : prev);
      toast.error(e.message);
    }
  };

  const statusConfig: Record<TrainStatus, { color: string; label: string }> = {
    idle: { color: "bg-zinc-600", label: "Ready" },
    uploading: { color: "bg-blue-500 animate-pulse", label: "Uploading dataset..." },
    provisioning: { color: "bg-yellow-500 animate-pulse", label: "Spinning up GPU..." },
    training: { color: "bg-orange-500 animate-pulse", label: "Training YOLO model..." },
    complete: { color: "bg-emerald-500", label: "Complete" },
    error: { color: "bg-red-500", label: "Error" },
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <Toaster theme="dark" position="bottom-right" />

      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-zinc-400 hover:text-zinc-200 transition">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
              </svg>
            </Link>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Train Model</h1>
              <p className="text-sm text-zinc-500">
                Upload a labeled dataset and train a YOLO model on GPU
              </p>
            </div>
          </div>
          <Link href="/build" className="text-sm text-blue-400 hover:text-blue-300">
            Need to label first? Go to Build
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-4xl p-6 space-y-6">
        {/* Upload section */}
        <div className="grid gap-6 md:grid-cols-2">
          {/* COCO JSON */}
          <Card className="bg-zinc-900 border-zinc-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">COCO Annotations</CardTitle>
              <p className="text-[11px] text-zinc-500">
                The JSON file from Build page or data_label_factory export
              </p>
            </CardHeader>
            <CardContent>
              <label className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition ${
                cocoFile ? "border-emerald-500 bg-emerald-950/20" : "border-zinc-700 hover:border-zinc-600"
              }`}>
                {cocoFile ? (
                  <div className="text-center">
                    <div className="text-emerald-400 font-semibold">{cocoFile.name}</div>
                    <div className="text-xs text-zinc-500 mt-1">{(cocoFile.size / 1024).toFixed(1)} KB</div>
                  </div>
                ) : (
                  <div className="text-center">
                    <div className="text-zinc-400">Drop COCO JSON here</div>
                    <div className="text-xs text-zinc-500 mt-1">or click to browse</div>
                  </div>
                )}
                <input
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && setCocoFile(e.target.files[0])}
                />
              </label>
            </CardContent>
          </Card>

          {/* Images */}
          <Card className="bg-zinc-900 border-zinc-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Training Images</CardTitle>
              <p className="text-[11px] text-zinc-500">
                The images referenced in the COCO file
              </p>
            </CardHeader>
            <CardContent>
              <label className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition ${
                imageFiles.length > 0 ? "border-emerald-500 bg-emerald-950/20" : "border-zinc-700 hover:border-zinc-600"
              }`}>
                {imageFiles.length > 0 ? (
                  <div className="text-center">
                    <div className="text-emerald-400 font-semibold">{imageFiles.length} images</div>
                    <div className="text-xs text-zinc-500 mt-1">
                      {(imageFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB total
                    </div>
                  </div>
                ) : (
                  <div className="text-center">
                    <div className="text-zinc-400">Drop images here</div>
                    <div className="text-xs text-zinc-500 mt-1">JPG, PNG — all images from the dataset</div>
                  </div>
                )}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => e.target.files && setImageFiles(Array.from(e.target.files))}
                />
              </label>
            </CardContent>
          </Card>
        </div>

        {/* Config */}
        <Card className="bg-zinc-900 border-zinc-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Training Config</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-4">
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Target object</label>
                <input
                  type="text"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="e.g. stop sign"
                  className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Epochs</label>
                <select
                  value={epochs}
                  onChange={(e) => setEpochs(Number(e.target.value))}
                  className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"
                >
                  <option value={25}>25 (fast)</option>
                  <option value={50}>50 (default)</option>
                  <option value={100}>100 (thorough)</option>
                  <option value={200}>200 (maximum)</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Base model</label>
                <select
                  value={modelBase}
                  onChange={(e) => setModelBase(e.target.value)}
                  className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"
                >
                  <option value="yolo11n.pt">YOLO11n (fast, small)</option>
                  <option value="yolo11s.pt">YOLO11s (balanced)</option>
                  <option value="yolo11m.pt">YOLO11m (accurate)</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">GPU</label>
                <div className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-400">
                  RunPod GPU (auto)
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Train button */}
        <div className="flex items-center justify-between">
          <div className="text-sm text-zinc-400">
            {cocoFile && imageFiles.length > 0
              ? `Ready: ${imageFiles.length} images + ${cocoFile.name}`
              : "Upload COCO JSON + images to start"}
          </div>
          <Button
            onClick={startTraining}
            disabled={!cocoFile || imageFiles.length === 0 || (job?.status === "training") || (job?.status === "uploading")}
            className="bg-orange-600 hover:bg-orange-500 px-8 h-11 text-base font-semibold shadow-lg shadow-orange-600/25"
          >
            {job?.status === "uploading" || job?.status === "training" ? (
              <>
                <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                {job.status === "uploading" ? "Uploading..." : "Training..."}
              </>
            ) : (
              <>
                Train Model
                <svg className="ml-2 h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.58-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
                </svg>
              </>
            )}
          </Button>
        </div>

        {/* Training progress */}
        {job && (
          <Card className={`border ${
            job.status === "complete" ? "bg-emerald-950/20 border-emerald-700" :
            job.status === "error" ? "bg-red-950/20 border-red-700" :
            "bg-zinc-900 border-zinc-800"
          }`}>
            <CardContent className="pt-6">
              {/* Status bar */}
              <div className="flex items-center gap-3 mb-4">
                <div className={`h-3 w-3 rounded-full ${statusConfig[job.status].color}`} />
                <span className="font-semibold">{statusConfig[job.status].label}</span>
                {job.elapsed && (
                  <span className="text-sm text-zinc-400 ml-auto">{Math.round(job.elapsed)}s</span>
                )}
              </div>

              {/* Progress stages */}
              <div className="grid grid-cols-4 gap-2 mb-4">
                {(["uploading", "provisioning", "training", "complete"] as TrainStatus[]).map((stage, i) => {
                  const stages: TrainStatus[] = ["uploading", "provisioning", "training", "complete"];
                  const currentIdx = stages.indexOf(job.status);
                  const stageIdx = i;
                  const isDone = stageIdx < currentIdx || job.status === "complete";
                  const isCurrent = stageIdx === currentIdx && job.status !== "complete" && job.status !== "error";
                  return (
                    <div key={stage} className="text-center">
                      <div className={`h-1.5 rounded-full mb-2 ${
                        isDone ? "bg-emerald-500" :
                        isCurrent ? "bg-orange-500 animate-pulse" :
                        "bg-zinc-700"
                      }`} />
                      <span className={`text-[11px] ${
                        isDone ? "text-emerald-400" :
                        isCurrent ? "text-orange-400" :
                        "text-zinc-500"
                      }`}>
                        {["Upload", "GPU", "Train", "Done"][i]}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Training progress detail */}
              {job.progress && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Epoch {job.progress.epoch}/{job.progress.total}</span>
                    {job.progress.loss && <span className="text-zinc-400">Loss: {job.progress.loss.toFixed(4)}</span>}
                  </div>
                  <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-orange-500 transition-all"
                      style={{ width: `${(job.progress.epoch / job.progress.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Job details */}
              <div className="grid grid-cols-4 gap-4 mt-4 text-center text-sm">
                <div>
                  <div className="text-lg font-bold">{job.nImages}</div>
                  <div className="text-zinc-500">Images</div>
                </div>
                <div>
                  <div className="text-lg font-bold">{job.nAnnotations || "—"}</div>
                  <div className="text-zinc-500">Bboxes</div>
                </div>
                <div>
                  <div className="text-lg font-bold">{job.epochs}</div>
                  <div className="text-zinc-500">Epochs</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-zinc-400">{job.gpu}</div>
                  <div className="text-zinc-500">GPU</div>
                </div>
              </div>

              {/* Complete: download button */}
              {job.status === "complete" && job.modelUrl && (
                <div className="mt-6 flex gap-3">
                  <Button
                    onClick={() => window.open(job.modelUrl, "_blank")}
                    className="bg-emerald-600 hover:bg-emerald-500 px-6"
                  >
                    Download best.pt
                    <svg className="ml-2 h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                    </svg>
                  </Button>
                  <div className="flex items-center gap-2 text-sm text-zinc-400">
                    <span>Your custom <strong>{target}</strong> detector is ready</span>
                  </div>
                </div>
              )}

              {/* Complete without model (dataset only) */}
              {job.status === "complete" && !job.modelUrl && job.error && (
                <div className="mt-4 rounded bg-zinc-800 p-3 text-sm text-zinc-400">
                  {job.error}
                </div>
              )}

              {/* Error */}
              {job.status === "error" && (
                <div className="mt-4 rounded bg-red-950 p-3 text-sm text-red-300">
                  {job.error}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* How it works */}
        <Card className="bg-zinc-900/50 border-zinc-800">
          <CardContent className="pt-6">
            <h3 className="font-semibold mb-3">How training works</h3>
            <div className="grid grid-cols-4 gap-4 text-center text-sm">
              {[
                { step: "1", title: "Upload", desc: "COCO JSON + images from the Build page" },
                { step: "2", title: "Convert", desc: "COCO to YOLO format with train/val split" },
                { step: "3", title: "Train", desc: "YOLO11 fine-tuning on RunPod GPU" },
                { step: "4", title: "Download", desc: "Get your custom best.pt model" },
              ].map((s) => (
                <div key={s.step}>
                  <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-orange-600/20 text-orange-400 text-sm font-bold mb-2">
                    {s.step}
                  </div>
                  <div className="font-medium">{s.title}</div>
                  <div className="text-xs text-zinc-500 mt-1">{s.desc}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
