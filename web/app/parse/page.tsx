"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import SiteNav from "@/components/SiteNav";

type PageBlock = {
  type: string;
  bbox?: number[];
  text?: string;
  confidence?: number;
};

type ParsedPage = {
  page: number;
  width?: number;
  height?: number;
  blocks?: PageBlock[];
};

type ParseResponse = {
  backend: string;
  file?: string;
  text?: string;
  pages?: ParsedPage[];
  annotations?: any[];
  metadata?: any;
  elapsed_ms?: number;
  size_mb?: number;
  error?: string;
  hint?: string;
};

const SUPPORTED_EXT = [".pdf", ".docx", ".xlsx", ".pptx", ".png", ".jpg", ".jpeg", ".tiff", ".tif"];
const MAX_MB = 50;

export default function ParsePage() {
  const [file, setFile] = useState<File | null>(null);
  const [backend, setBackend] = useState<"liteparse" | "chandra">("liteparse");
  const [ocr, setOcr] = useState(false);
  const [result, setResult] = useState<ParseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const handleFile = (f: File) => {
    setError(null);
    setResult(null);
    const name = f.name.toLowerCase();
    if (!SUPPORTED_EXT.some((ext) => name.endsWith(ext))) {
      setError(`Unsupported file type. Supported: ${SUPPORTED_EXT.join(", ")}`);
      return;
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      setError(`File too large (${(f.size / 1024 / 1024).toFixed(1)} MB > ${MAX_MB} MB cap).`);
      return;
    }
    setFile(f);
  };

  const submit = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);

    const form = new FormData();
    form.append("file", file);
    form.append("backend", backend);
    form.append("ocr", ocr ? "true" : "false");

    try {
      const res = await fetch("/api/parse", { method: "POST", body: form });
      const data: ParseResponse & { self_hosted_only?: boolean; install?: string; alternative?: string } = await res.json();
      if (!res.ok) {
        if (data.self_hosted_only) {
          setError(
            `Parse runs on a self-hosted Python backend — not available on the public demo. Install locally:\n\n  ${data.install}\n\nOr use /go for browser-based image labeling (no install).`,
          );
        } else {
          setError(data.error || `HTTP ${res.status}`);
        }
      } else {
        setResult(data);
      }
    } catch (e: any) {
      setError(`Request failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const blockCount =
    result?.pages?.reduce((sum, p) => sum + (p.blocks?.length || 0), 0) ||
    result?.annotations?.length ||
    0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <SiteNav />

      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-8">
          <h1 className="text-4xl font-bold">Parse documents</h1>
          <p className="mt-2 text-zinc-400">
            Layout-preserving extraction for PDFs, Office docs, and images.
            Fast local parsing via LiteParse, heavy OCR via Chandra.
          </p>
        </div>

        {/* Controls */}
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <div className="space-y-4">
            <div
              onDrop={onDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => inputRef.current?.click()}
              className="flex h-48 cursor-pointer items-center justify-center rounded-2xl border-2 border-dashed border-zinc-700 bg-zinc-900/40 hover:border-blue-500 hover:bg-zinc-900/80"
            >
              <div className="text-center">
                <div className="text-lg font-medium">
                  {file ? file.name : "Drop a document here"}
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  {file
                    ? `${(file.size / 1024 / 1024).toFixed(2)} MB`
                    : `PDF, DOCX, XLSX, PPTX, PNG, JPG, TIFF — max ${MAX_MB} MB`}
                </div>
              </div>
              <input
                ref={inputRef}
                type="file"
                hidden
                accept={SUPPORTED_EXT.join(",")}
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
            </div>

            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="mb-3 text-sm font-medium text-zinc-400">Backend</div>
              <div className="flex gap-2">
                {(["liteparse", "chandra"] as const).map((b) => (
                  <button
                    key={b}
                    onClick={() => setBackend(b)}
                    className={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium ${
                      backend === b
                        ? "border-blue-500 bg-blue-500/10 text-blue-300"
                        : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <div className="font-semibold">{b === "liteparse" ? "LiteParse" : "Chandra"}</div>
                    <div className="mt-1 text-xs opacity-80">
                      {b === "liteparse" ? "Fast, local, no GPU" : "Heavy OCR, GPU recommended"}
                    </div>
                  </button>
                ))}
              </div>

              <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={ocr}
                  onChange={(e) => setOcr(e.target.checked)}
                  className="mt-0.5"
                />
                <div>
                  <div className="font-medium text-zinc-200">Force OCR</div>
                  <div className="text-xs text-zinc-500">
                    Heaviest path. Enable only for scanned pages. RAM-intensive on Mac Mini.
                  </div>
                </div>
              </label>
            </div>

            <button
              onClick={submit}
              disabled={!file || loading}
              className="w-full rounded-xl bg-blue-600 px-6 py-3 font-semibold hover:bg-blue-500 disabled:opacity-40"
            >
              {loading ? "Parsing…" : "Parse document"}
            </button>

            {error && (
              <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
                {error}
              </div>
            )}
          </div>

          {/* Result */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 min-h-[400px]">
            {!result && !loading && (
              <div className="flex h-full items-center justify-center text-zinc-600">
                Results appear here
              </div>
            )}

            {result && (
              <div className="space-y-4">
                <div className="flex gap-6 text-sm">
                  <Stat label="backend" value={result.backend} />
                  <Stat label="time" value={`${result.elapsed_ms ?? "?"} ms`} />
                  <Stat label="size" value={`${result.size_mb ?? "?"} MB`} />
                  <Stat label="blocks" value={String(blockCount)} />
                </div>

                {result.text && (
                  <div>
                    <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">
                      Text preview
                    </div>
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-4 font-mono text-xs text-zinc-300">
                      {result.text.slice(0, 5000)}
                      {result.text.length > 5000 && "\n…(truncated)"}
                    </pre>
                  </div>
                )}

                {(result.pages?.length || 0) > 0 && (
                  <div>
                    <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">
                      Pages
                    </div>
                    <div className="space-y-2">
                      {result.pages!.map((p) => (
                        <div
                          key={p.page}
                          className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs"
                        >
                          <div className="text-zinc-300">
                            Page {p.page} — {p.blocks?.length || 0} blocks
                            {p.width && p.height && ` (${p.width}×${p.height})`}
                          </div>
                          {(p.blocks || []).slice(0, 3).map((b, i) => (
                            <div key={i} className="mt-1 text-zinc-500">
                              [{b.type}] {(b.text || "").slice(0, 70)}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {result.annotations && (
                  <div>
                    <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">
                      Annotations (COCO)
                    </div>
                    <pre className="max-h-80 overflow-auto rounded-lg bg-zinc-950 p-4 font-mono text-xs text-zinc-300">
                      {JSON.stringify(result.annotations.slice(0, 20), null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {loading && (
              <div className="flex h-full items-center justify-center text-zinc-400">
                <div className="animate-pulse">Parsing {file?.name}…</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-zinc-200">{value}</div>
    </div>
  );
}
