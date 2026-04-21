"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import { useRouter } from "next/navigation";

/**
 * /template/intake — "cluster-before-label" intake flow.
 *
 * User drops a folder of mixed PDFs (up to 50). We POST them to
 * /api/cluster which runs LiteParse + layout fingerprinting and returns
 * doc groups. The user picks one cluster to build a template from.
 *
 * Blue dark theme matches /parse (the parallel doc-tooling page).
 */

type ClusterResult = {
  cluster_id: string;
  doc_ids: string[];
  doc_count: number;
  suggested_name: string;
  sample_filenames: string[];
};

type ClusterResponse = {
  job_id: string;
  cluster_count: number;
  total_docs: number;
  clusters: ClusterResult[];
  errors?: Array<{ filename: string; error: string }>;
  error?: string;
};

const MAX_FILES = 50;
const MAX_MB = 50;
const SUPPORTED_EXT = [".pdf", ".docx", ".xlsx", ".pptx", ".png", ".jpg", ".jpeg", ".tiff", ".tif"];

const CLUSTER_ICON: Record<string, string> = {
  invoice: "🧾",
  w2: "📋",
  "1099": "📋",
  receipt: "🧾",
  contract: "📑",
  resume: "👤",
  statement: "📊",
  letter: "✉️",
  report: "📄",
  unknown: "📄",
};

const CLUSTER_LABEL: Record<string, string> = {
  invoice: "Invoices",
  w2: "W-2s",
  "1099": "1099s",
  receipt: "Receipts",
  contract: "Contracts",
  resume: "Resumes",
  statement: "Statements",
  letter: "Letters",
  report: "Reports",
  unknown: "Documents",
};

export default function TemplateIntakePage() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<ClusterResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const totalMb = useMemo(
    () => files.reduce((s, f) => s + f.size / 1024 / 1024, 0),
    [files],
  );

  const addFiles = (list: FileList | File[]) => {
    setError(null);
    setResult(null);
    const incoming = Array.from(list);
    const valid: File[] = [];
    for (const f of incoming) {
      const name = f.name.toLowerCase();
      if (!SUPPORTED_EXT.some((ext) => name.endsWith(ext))) {
        setError(`Unsupported file: ${f.name}`);
        continue;
      }
      if (f.size > MAX_MB * 1024 * 1024) {
        setError(`${f.name} is too large (> ${MAX_MB} MB cap)`);
        continue;
      }
      valid.push(f);
    }
    const next = [...files, ...valid].slice(0, MAX_FILES);
    if (files.length + valid.length > MAX_FILES) {
      setError(`Only the first ${MAX_FILES} files are kept.`);
    }
    setFiles(next);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const reset = () => {
    setFiles([]);
    setResult(null);
    setError(null);
    setProgress(0);
  };

  const submit = async () => {
    if (files.length === 0) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setProgress(0);

    // We upload via XHR so we can show real byte-level progress.
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name);

    try {
      const data: ClusterResponse = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/cluster");
        xhr.responseType = "text";
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            setProgress(Math.round((ev.loaded / ev.total) * 100));
          }
        };
        xhr.onload = () => {
          try {
            const parsed = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300) resolve(parsed);
            else reject(new Error(parsed.error || `HTTP ${xhr.status}`));
          } catch (e: any) {
            reject(new Error(`Bad server response (${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.send(form);
      });

      setResult(data);
    } catch (e: any) {
      setError(e.message || "Cluster request failed");
    } finally {
      setLoading(false);
    }
  };

  const pickCluster = (cluster: ClusterResult) => {
    const qs = new URLSearchParams({
      cluster_id: cluster.cluster_id,
      suggested_name: cluster.suggested_name,
    });
    if (result?.job_id) qs.set("job_id", result.job_id);
    router.push(`/template/new?${qs.toString()}`);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <SiteNav />

      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-8">
          <h1 className="text-4xl font-bold">Cluster before you label</h1>
          <p className="mt-2 max-w-3xl text-zinc-400">
            Drop a folder of mixed PDFs. We&apos;ll auto-group them by layout
            similarity — invoices land with invoices, W-2s with W-2s. Pick one
            cluster, build a template from <em>one</em> doc, and extract the rest.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          {/* Left: uploader */}
          <div className="space-y-4">
            <div
              onDrop={onDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => inputRef.current?.click()}
              className="flex h-48 cursor-pointer items-center justify-center rounded-2xl border-2 border-dashed border-zinc-700 bg-zinc-900/40 hover:border-blue-500 hover:bg-zinc-900/80"
            >
              <div className="text-center">
                <div className="text-lg font-medium">
                  {files.length > 0
                    ? `${files.length} file${files.length > 1 ? "s" : ""} ready`
                    : "Drop a folder of PDFs here"}
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  {files.length > 0
                    ? `${totalMb.toFixed(1)} MB total — click to add more`
                    : `PDF, DOCX, XLSX, PPTX, images — up to ${MAX_FILES} files, ${MAX_MB} MB each`}
                </div>
              </div>
              <input
                ref={inputRef}
                type="file"
                hidden
                multiple
                accept={SUPPORTED_EXT.join(",")}
                onChange={(e) => e.target.files && addFiles(e.target.files)}
              />
            </div>

            {files.length > 0 && (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="mb-3 flex items-center justify-between text-sm">
                  <span className="font-medium text-zinc-400">
                    Staged ({files.length}/{MAX_FILES})
                  </span>
                  <button
                    onClick={reset}
                    className="text-xs text-zinc-500 hover:text-zinc-200"
                  >
                    Clear all
                  </button>
                </div>
                <div className="max-h-64 space-y-1 overflow-auto pr-1">
                  {files.map((f, i) => (
                    <div
                      key={`${f.name}-${i}`}
                      className="flex items-center justify-between rounded-lg bg-zinc-950/60 px-3 py-2 text-xs"
                    >
                      <div className="truncate text-zinc-300">{f.name}</div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="font-mono text-zinc-500">
                          {(f.size / 1024 / 1024).toFixed(2)} MB
                        </span>
                        <button
                          onClick={() => removeFile(i)}
                          className="text-zinc-500 hover:text-red-400"
                          aria-label={`Remove ${f.name}`}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={submit}
              disabled={files.length === 0 || loading}
              className="w-full rounded-xl bg-blue-600 px-6 py-3 font-semibold hover:bg-blue-500 disabled:opacity-40"
            >
              {loading
                ? progress < 100
                  ? `Uploading ${progress}%…`
                  : "Parsing & clustering…"
                : `Cluster ${files.length || ""} document${files.length === 1 ? "" : "s"}`.trim()}
            </button>

            {loading && (
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{ width: `${Math.max(5, progress)}%` }}
                />
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
                {error}
              </div>
            )}
          </div>

          {/* Right: cluster results */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 min-h-[400px]">
            {!result && !loading && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-zinc-600">
                <div className="text-5xl">📦</div>
                <div>Clusters appear here after intake.</div>
                <div className="max-w-sm text-xs text-zinc-700">
                  The heuristic groups by page count, block density, font
                  size, and top-token overlap — see{" "}
                  <span className="font-mono">data_label_factory/doc_cluster.py</span>.
                </div>
              </div>
            )}

            {loading && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-400">
                <div className="animate-pulse text-sm">
                  {progress < 100
                    ? `Uploading ${files.length} files…`
                    : `Parsing ${files.length} documents — this runs sequentially for RAM safety.`}
                </div>
                <div className="text-xs text-zinc-600">
                  ~1-3 s per PDF on the Mini.
                </div>
              </div>
            )}

            {result && (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-6 border-b border-zinc-800 pb-4 text-sm">
                  <Stat label="job id" value={result.job_id.slice(0, 8)} />
                  <Stat
                    label="clusters"
                    value={String(result.cluster_count)}
                  />
                  <Stat label="docs" value={String(result.total_docs)} />
                  {result.errors && result.errors.length > 0 && (
                    <Stat
                      label="skipped"
                      value={String(result.errors.length)}
                    />
                  )}
                </div>

                <div className="space-y-3">
                  {result.clusters.map((c) => (
                    <ClusterCard
                      key={c.cluster_id}
                      cluster={c}
                      onPick={() => pickCluster(c)}
                    />
                  ))}
                </div>

                {result.errors && result.errors.length > 0 && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                    <div className="mb-1 font-medium text-amber-300">
                      Skipped {result.errors.length} file
                      {result.errors.length > 1 ? "s" : ""}:
                    </div>
                    <ul className="space-y-0.5 text-amber-200/80">
                      {result.errors.slice(0, 5).map((e, i) => (
                        <li key={i} className="truncate">
                          <span className="font-mono">{e.filename}</span> — {e.error}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="pt-2">
                  <button
                    onClick={reset}
                    className="text-sm text-zinc-400 hover:text-zinc-200"
                  >
                    ← Intake another batch
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ClusterCard({
  cluster,
  onPick,
}: {
  cluster: ClusterResult;
  onPick: () => void;
}) {
  const name = cluster.suggested_name || "unknown";
  const icon = CLUSTER_ICON[name] ?? "📄";
  const label = CLUSTER_LABEL[name] ?? "Documents";

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-5 transition hover:border-blue-500/60">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{icon}</span>
            <div>
              <div className="text-lg font-semibold text-zinc-100">
                {label}{" "}
                <span className="text-zinc-500">
                  — {cluster.doc_count} document{cluster.doc_count > 1 ? "s" : ""}
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
                {cluster.cluster_id} · {name}
              </div>
            </div>
          </div>

          {cluster.sample_filenames.length > 0 && (
            <div className="mt-3 text-xs text-zinc-500">
              <span className="text-zinc-600">sample: </span>
              {cluster.sample_filenames.slice(0, 3).join(", ")}
              {cluster.sample_filenames.length > 3 &&
                `, +${cluster.doc_count - 3} more`}
            </div>
          )}
        </div>

        <button
          onClick={onPick}
          className="shrink-0 rounded-xl border border-blue-500/40 bg-blue-500/10 px-4 py-2 text-sm font-medium text-blue-200 hover:border-blue-400 hover:bg-blue-500/20"
        >
          Build template →
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm text-zinc-200">{value}</div>
    </div>
  );
}
