"use client";

/**
 * /template/[id] — view a saved template + run batch extraction.
 *
 * Flow:
 *   - Load template by name from /api/template/[id]
 *   - Show field list
 *   - Drag-drop N PDFs
 *   - For each: POST /api/template-extract → structured row
 *   - Table view with per-field confidence
 *   - Export CSV / JSON
 *   - User can click a row's low-confidence cell → jumps to edit mode
 *
 * Corrections made here feed /api/rewards with source_type=doc so the
 * GRPO pool learns from real-world usage.
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

type FieldDef = {
  name: string;
  label: string;
  type: string;
  required: boolean;
  bbox: number[];
  page: number;
};

type Template = {
  name: string;
  display_name: string;
  description: string;
  doc_type: string;
  page_size: [number, number];
  fields: FieldDef[];
  source: string;
};

type ExtractedRow = {
  filename: string;
  fields: Record<string, { value: any; raw_text: string; confidence: number; matched_block_count: number; bbox_used: number[] }>;
  elapsed_ms?: number;
  error?: string;
};

export default function TemplateViewerPage() {
  const params = useParams();
  const id = params?.id as string;

  const [tpl, setTpl] = useState<Template | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [rows, setRows] = useState<ExtractedRow[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  // Try user first, fall back to library (matches backend semantics)
  useEffect(() => {
    (async () => {
      for (const lib of [false, true]) {
        try {
          const r = await fetch(`/api/template/${encodeURIComponent(id)}?library=${lib}`);
          if (r.ok) {
            setTpl(await r.json());
            return;
          }
        } catch {}
      }
      setLoadErr(`Template '${id}' not found`);
    })();
  }, [id]);

  const handleBatch = useCallback(async (files: File[]) => {
    if (!tpl || files.length === 0) return;
    setRows([]);
    setProgress({ done: 0, total: files.length });
    setProcessing(true);

    // Sequential processing — RAM-safe for Mac Mini. For production, scale up.
    const newRows: ExtractedRow[] = [];
    const isLibrary = tpl.source === "marketplace" || tpl.source === "library";

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const form = new FormData();
      form.append("file", f);
      form.append("template_name", tpl.name);
      form.append("library", String(isLibrary));

      try {
        // Call DLF backend directly (no Next.js proxy yet for this endpoint)
        const r = await fetch(`/api/dlf?path=/api/template-extract`, {
          method: "POST",
          body: form,
        });
        const data = await r.json();
        if (!r.ok) {
          newRows.push({ filename: f.name, fields: {}, error: data.detail || data.error || "extract failed" });
        } else {
          newRows.push({ filename: f.name, fields: data.fields || {}, elapsed_ms: data.elapsed_ms });
        }
      } catch (e: any) {
        newRows.push({ filename: f.name, fields: {}, error: e.message });
      }
      setRows([...newRows]);
      setProgress({ done: i + 1, total: files.length });
    }

    setProcessing(false);
  }, [tpl]);

  const exportCSV = () => {
    if (!tpl || rows.length === 0) return;
    const header = ["filename", ...tpl.fields.map((f) => f.name), "elapsed_ms", "error"].join(",");
    const body = rows.map((r) => {
      const cells = [
        csvCell(r.filename),
        ...tpl.fields.map((f) => csvCell(String(r.fields[f.name]?.value ?? ""))),
        String(r.elapsed_ms || ""),
        csvCell(r.error || ""),
      ];
      return cells.join(",");
    });
    const blob = new Blob([[header, ...body].join("\n")], { type: "text/csv" });
    downloadBlob(blob, `${tpl.name}-extractions.csv`);
  };

  const exportJSON = () => {
    if (!tpl) return;
    const blob = new Blob(
      [JSON.stringify({ template: tpl.name, extracted_at: new Date().toISOString(), rows }, null, 2)],
      { type: "application/json" },
    );
    downloadBlob(blob, `${tpl.name}-extractions.json`);
  };

  if (loadErr) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <div className="text-center">
          <div className="text-red-400">{loadErr}</div>
          <Link href="/template/library" className="mt-4 inline-block text-blue-400 hover:text-blue-300">
            Browse templates →
          </Link>
        </div>
      </div>
    );
  }

  if (!tpl) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center text-zinc-500">
        Loading template…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-bold">Data Label Factory</Link>
          <div className="flex gap-6 text-sm text-zinc-400">
            <Link href="/template/library" className="hover:text-white">Library</Link>
            <Link href="/template/intake" className="hover:text-white">Intake</Link>
            <Link href="/template/new" className="hover:text-white">Editor</Link>
            <Link href="/parse" className="hover:text-white">Parse</Link>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-6 py-8">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold">{tpl.display_name}</h1>
              <span className="rounded-full bg-zinc-800 px-3 py-0.5 text-xs text-zinc-300">{tpl.doc_type}</span>
              <span className="rounded-full bg-blue-500/10 text-blue-300 px-3 py-0.5 text-xs">{tpl.source}</span>
            </div>
            <p className="mt-1 text-sm text-zinc-400">{tpl.description}</p>
            <p className="mt-1 text-xs text-zinc-600">{tpl.fields.length} fields</p>
          </div>
          <div className="flex gap-2">
            <Link
              href={`/template/new?base=${tpl.name}`}
              className="rounded-lg border border-zinc-700 hover:border-zinc-500 px-4 py-2 text-sm"
            >
              Customize
            </Link>
            {rows.length > 0 && (
              <>
                <button onClick={exportCSV} className="rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2 text-sm font-semibold">
                  Export CSV
                </button>
                <button onClick={exportJSON} className="rounded-lg border border-zinc-700 hover:border-zinc-500 px-4 py-2 text-sm">
                  Export JSON
                </button>
              </>
            )}
          </div>
        </div>

        {/* Drop zone */}
        <div
          className="mb-6 rounded-2xl border-2 border-dashed border-zinc-700 hover:border-blue-500 bg-zinc-900/30 p-10 text-center cursor-pointer"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const files = Array.from(e.dataTransfer.files);
            handleBatch(files);
          }}
          onClick={() => document.getElementById("batch-input")?.click()}
        >
          <div className="text-lg font-semibold">
            {processing
              ? `Extracting ${progress.done}/${progress.total}…`
              : "Drop PDFs here to batch-extract"}
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            Any number of files. Uses this template for every one.
          </div>
          <input
            id="batch-input"
            type="file"
            multiple
            hidden
            accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.tiff"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              handleBatch(files);
            }}
          />
        </div>

        {/* Results */}
        {rows.length > 0 && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-zinc-900 text-zinc-400 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">File</th>
                  {tpl.fields.map((f) => (
                    <th key={f.name} className="text-left px-3 py-2 font-medium">
                      {f.label}
                      {f.required && <span className="text-red-400 ml-1">*</span>}
                    </th>
                  ))}
                  <th className="text-right px-3 py-2 font-medium">ms</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-t border-zinc-800 hover:bg-zinc-900/50">
                    <td className="px-3 py-2 truncate max-w-[200px]" title={row.filename}>
                      {row.filename}
                    </td>
                    {tpl.fields.map((f) => {
                      const cell = row.fields[f.name];
                      const conf = cell?.confidence ?? 0;
                      return (
                        <td
                          key={f.name}
                          className="px-3 py-2 align-top"
                          title={cell?.raw_text || ""}
                        >
                          {row.error ? (
                            <span className="text-red-400">—</span>
                          ) : cell?.value != null && cell.value !== "" ? (
                            <div>
                              <div className="text-zinc-200">{String(cell.value).slice(0, 40)}</div>
                              {conf < 0.7 && (
                                <div className="text-[10px] text-amber-400 mt-0.5">
                                  low conf ({conf.toFixed(2)})
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right text-zinc-500">
                      {row.error ? "fail" : row.elapsed_ms || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Template fields summary */}
        {rows.length === 0 && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6">
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-3">
              This template extracts {tpl.fields.length} fields
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {tpl.fields.map((f) => (
                <div key={f.name} className="flex items-center justify-between rounded-lg bg-zinc-900/60 px-3 py-2 text-sm">
                  <span className="text-zinc-200">
                    {f.label}
                    {f.required && <span className="text-red-400 ml-1">*</span>}
                  </span>
                  <span className="text-[11px] text-zinc-500">{f.type}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function csvCell(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
