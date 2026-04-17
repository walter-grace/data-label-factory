"use client";

/**
 * /template/new — document-extraction template editor.
 *
 * Flow:
 *   1. Drop first PDF  →  upload + parse + render page PNG
 *   2. Auto-seed bboxes from parsed blocks (font_size >= 14 or explicit header)
 *   3. User draws new boxes, edits existing, sets label + type + anchor_text
 *   4. Save  →  POST /api/template  →  appears in library for batch apply
 *
 * URL params:
 *   ?base=<library_template_name>  seed fields from a library template
 *   ?cluster_id=<id>               seed from cluster intake (agent B)
 *   ?mode=schema                   show schema-first panel instead of canvas-first
 *
 * NOTE: Rendering assumes the backend returned both the lit parse result
 *       AND a rendered page PNG (we call /api/parse + /api/render-page).
 *       If /api/render-page isn't available we fall back to displaying
 *       the PDF via an <object> fallback.
 */

import { useState, useRef, useEffect, useCallback, useMemo, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

type FieldType = "text" | "number" | "currency" | "date" | "email" | "phone" | "table" | "boolean";

type TemplateField = {
  name: string;
  label: string;
  bbox: [number, number, number, number];  // PDF points
  type: FieldType;
  required: boolean;
  anchor_text?: string;
  page: number;
};

type ParsedBlock = {
  type: string;
  bbox: [number, number, number, number];
  text: string;
  confidence?: number;
  font_size?: number;
};

type ParseResponse = {
  backend: string;
  file: string;
  text: string;
  pages: Array<{
    page: number;
    width: number;
    height: number;
    text: string;
    blocks: ParsedBlock[];
  }>;
  elapsed_ms?: number;
};

const RENDER_DPI = 150;
const PDF_DPI = 72;
const SCALE = RENDER_DPI / PDF_DPI;
const DLF_API = typeof window !== "undefined" ? "" : "http://127.0.0.1:8400";

function TemplateNewPageInner() {
  const params = useSearchParams();
  const baseParam = params.get("base");
  const clusterId = params.get("cluster_id");
  const modeParam = params.get("mode");

  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
  const [pageW, setPageW] = useState(612);
  const [pageH, setPageH] = useState(792);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fields, setFields] = useState<TemplateField[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [drawingBox, setDrawingBox] = useState<[number, number, number, number] | null>(null);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);

  const [templateName, setTemplateName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [docType, setDocType] = useState("generic");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Schema-first mode state
  const [schemaFields, setSchemaFields] = useState<Array<{ name: string; label: string; type: FieldType; required: boolean }>>([]);

  // ── Seed from library template / cluster on mount ──
  useEffect(() => {
    if (baseParam) {
      fetch(`/api/template/${encodeURIComponent(baseParam)}?library=true`)
        .then((r) => r.json())
        .then((tpl) => {
          if (tpl.fields) {
            setFields(
              tpl.fields.map((f: any) => ({
                name: f.name,
                label: f.label || f.name,
                bbox: f.bbox,
                type: (f.type || "text") as FieldType,
                required: !!f.required,
                anchor_text: f.anchor_text,
                page: f.page || 1,
              })),
            );
          }
          setTemplateName(`${tpl.name}-custom`);
          setDisplayName(`${tpl.display_name || tpl.name} (custom)`);
          setDescription(`Customized from ${tpl.display_name || tpl.name}`);
          setDocType(tpl.doc_type || "generic");
          if (tpl.page_size) {
            setPageW(tpl.page_size[0]);
            setPageH(tpl.page_size[1]);
          }
        })
        .catch(() => {});
    }
    if (clusterId) {
      // cluster came from agent-B intake — we don't have the PDF yet, prompt user
      setError(`Drag the representative PDF from cluster ${clusterId} below.`);
    }
  }, [baseParam, clusterId]);

  // ── Upload + parse first PDF ──
  const handleFile = useCallback(async (f: File) => {
    setFile(f);
    setError(null);
    setParsing(true);
    setParsed(null);
    setPageImageUrl(null);

    const form = new FormData();
    form.append("file", f);
    form.append("backend", "liteparse");
    form.append("ocr", "false");

    try {
      const res = await fetch("/api/parse", { method: "POST", body: form });
      const data: ParseResponse = await res.json();
      if (!res.ok) {
        setError((data as any).error || "parse failed");
        return;
      }
      setParsed(data);
      if (data.pages[0]) {
        setPageW(data.pages[0].width || 612);
        setPageH(data.pages[0].height || 792);
      }

      // Don't auto-seed fields aggressively — let the user draw them
      // (auto-seeding every font>=12 block was too noisy)

      // Render the actual page as a PNG background using /api/render-page.
      // We re-upload the same file so the backend can screenshot it.
      try {
        const renderForm = new FormData();
        renderForm.append("file", f);
        renderForm.append("page", "1");
        renderForm.append("dpi", "150");
        const renderRes = await fetch("/api/render-page", { method: "POST", body: renderForm });
        if (renderRes.ok) {
          const blob = await renderRes.blob();
          setPageImageUrl(URL.createObjectURL(blob));
        }
      } catch {
        // Non-fatal — editor still works with text-only fallback
      }
    } catch (e: any) {
      setError(`Upload failed: ${e.message}`);
    } finally {
      setParsing(false);
    }
  }, [fields.length]);

  // ── Convert between PDF points and display pixels ──
  const ptsToPx = (pts: number) => pts * SCALE;
  const pxToPts = (px: number) => px / SCALE;

  // ── Canvas drawing handlers ──
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = pxToPts(e.clientX - rect.left);
    const y = pxToPts(e.clientY - rect.top);

    // Check if we clicked an existing bbox — select it
    const hit = fields.findIndex((f) =>
      x >= f.bbox[0] && x <= f.bbox[2] && y >= f.bbox[1] && y <= f.bbox[3],
    );
    if (hit >= 0) {
      setSelectedIdx(hit);
      return;
    }

    // Otherwise, start drawing a new box
    setDrawStart({ x, y });
    setDrawingBox([x, y, x, y]);
    setSelectedIdx(null);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!drawStart || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = pxToPts(e.clientX - rect.left);
    const y = pxToPts(e.clientY - rect.top);
    setDrawingBox([
      Math.min(drawStart.x, x),
      Math.min(drawStart.y, y),
      Math.max(drawStart.x, x),
      Math.max(drawStart.y, y),
    ]);
  };

  const handleMouseUp = () => {
    if (drawingBox && drawStart) {
      const [x1, y1, x2, y2] = drawingBox;
      if (x2 - x1 > 5 && y2 - y1 > 5) {
        const newField: TemplateField = {
          name: `field_${fields.length + 1}`,
          label: `Field ${fields.length + 1}`,
          bbox: [x1, y1, x2, y2],
          type: "text",
          required: false,
          page: 1,
        };
        setFields([...fields, newField]);
        setSelectedIdx(fields.length);
      }
    }
    setDrawStart(null);
    setDrawingBox(null);
  };

  // Keyboard — Delete key removes selected field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIdx !== null && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
          e.preventDefault();
          setFields((f) => f.filter((_, i) => i !== selectedIdx));
          setSelectedIdx(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIdx]);

  // ── Save template ──
  const saveTemplate = async () => {
    if (!templateName.trim()) {
      setError("Template name required");
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    setError(null);

    const slug = templateName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    try {
      const res = await fetch("/api/template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: slug,
          display_name: displayName || templateName,
          description,
          doc_type: docType,
          page_size: [pageW, pageH],
          fields,
          anchor_fields: fields.filter((f) => f.anchor_text).map((f) => f.name),
          source: clusterId ? "cluster" : modeParam === "schema" ? "schema" : "user",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || data.error || "save failed");
      } else {
        setSaveMsg(`Saved as ${data.name}. ${data.field_count} fields. Ready for batch extraction.`);
        // Emit flywheel feedback — user's labels become training data
        try {
          fields.forEach((f) => {
            fetch("/api/rewards", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                image_url: `template:${slug}`,
                target: f.type,
                label: "YES",
                reward: 3,
                source: `human:template-editor`,
                source_type: "doc",
                doc_id: slug,
                block_text: f.label,
                bbox: f.bbox,
                tentative_type: "user-labeled",
                trust_score: 100,
                is_honeypot: false,
                response_time_ms: 0,
                streak: 0,
              }),
            }).catch(() => {});
          });
        } catch {}
      }
    } catch (e: any) {
      setError(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const displayedBox = drawingBox;
  const selected = selectedIdx !== null ? fields[selectedIdx] : null;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-bold">Data Label Factory</Link>
          <div className="flex gap-6 text-sm text-zinc-400">
            <Link href="/template/library" className="hover:text-white">Library</Link>
            <Link href="/template/intake" className="hover:text-white">Intake</Link>
            <Link href="/template/new" className="text-white">Editor</Link>
            <Link href="/parse" className="hover:text-white">Parse</Link>
            <Link href="/play/docs" className="hover:text-white">Flywheel</Link>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold">Template editor</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Label one document. Apply the template to thousands. Every correction trains the GRPO model.
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {saveMsg && (
          <div className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200">
            {saveMsg}{" "}
            <Link href={`/template/${templateName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} className="font-semibold underline">
              Go to batch extract →
            </Link>
          </div>
        )}

        {!parsed && modeParam !== "schema" && (
          <div className="space-y-4">
            <FileDropzone onFile={handleFile} parsing={parsing} />
            <div className="text-center text-sm text-zinc-500">
              Prefer to define fields first, then map to the doc?{" "}
              <Link href="/template/new?mode=schema" className="text-blue-400 hover:text-blue-300 underline">
                Switch to schema-first mode
              </Link>
            </div>
          </div>
        )}

        {!parsed && modeParam === "schema" && (
          <SchemaFirstPanel
            schemaFields={schemaFields}
            setSchemaFields={setSchemaFields}
            onComplete={(fs, f) => {
              // Convert schema definitions → initial TemplateFields with placeholder bboxes
              // so when the user uploads the doc, each schema field becomes a draggable box.
              setFields(
                fs.map((s, i) => ({
                  name: s.name,
                  label: s.label,
                  type: s.type,
                  required: s.required,
                  bbox: [50, 50 + i * 50, 250, 90 + i * 50] as [number, number, number, number],
                  page: 1,
                })),
              );
              if (f) handleFile(f);
            }}
          />
        )}

        {parsed && (
          <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
            {/* Canvas */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-xs uppercase tracking-wider text-zinc-500">Page 1</div>
                  <div className="text-sm text-zinc-300">Click + drag to draw a field. Click existing to select.</div>
                </div>
                <div className="text-xs text-zinc-500">
                  {fields.length} field{fields.length === 1 ? "" : "s"}
                </div>
              </div>

              <div
                ref={canvasRef}
                className="relative overflow-auto rounded-xl border border-zinc-700 bg-white select-none cursor-crosshair"
                style={{ maxWidth: ptsToPx(pageW), maxHeight: "80vh" }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              >
                {/* Real page image (rendered via lit screenshot) */}
                {pageImageUrl ? (
                  <img
                    ref={imageRef}
                    src={pageImageUrl}
                    alt="Document page"
                    className="pointer-events-none"
                    style={{ width: ptsToPx(pageW), height: ptsToPx(pageH) }}
                    draggable={false}
                  />
                ) : (
                  /* Fallback: white canvas at page dimensions */
                  <div style={{ width: ptsToPx(pageW), height: ptsToPx(pageH) }} />
                )}

                {/* Field boxes */}
                {fields.map((f, i) => (
                  <div
                    key={`f-${i}`}
                    className={`absolute border-2 rounded-sm cursor-pointer ${
                      i === selectedIdx
                        ? "border-blue-500 bg-blue-500/15"
                        : "border-emerald-500/70 bg-emerald-500/10 hover:bg-emerald-500/20"
                    }`}
                    style={{
                      left: ptsToPx(f.bbox[0]),
                      top: ptsToPx(f.bbox[1]),
                      width: Math.max(ptsToPx(f.bbox[2] - f.bbox[0]), 20),
                      height: Math.max(ptsToPx(f.bbox[3] - f.bbox[1]), 14),
                    }}
                  >
                    <span
                      className={`absolute left-0 px-1 py-0.5 text-[9px] font-semibold leading-none whitespace-nowrap rounded-br ${
                        i === selectedIdx
                          ? "bg-blue-600 text-white"
                          : "bg-emerald-600/90 text-white"
                      }`}
                      style={{ top: 0 }}
                    >
                      {f.label}{f.required ? " *" : ""}
                    </span>
                  </div>
                ))}

                {/* Drawing preview */}
                {displayedBox && (
                  <div
                    className="absolute border-2 border-amber-400 bg-amber-400/20 rounded-sm pointer-events-none"
                    style={{
                      left: ptsToPx(displayedBox[0]),
                      top: ptsToPx(displayedBox[1]),
                      width: ptsToPx(displayedBox[2] - displayedBox[0]),
                      height: ptsToPx(displayedBox[3] - displayedBox[1]),
                    }}
                  />
                )}
              </div>
            </div>

            {/* Side panel */}
            <div className="space-y-4">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
                <div className="text-xs uppercase tracking-wider text-zinc-500">Template</div>
                <Input
                  placeholder="Slug (e.g. my-invoice)"
                  value={templateName}
                  onChange={setTemplateName}
                />
                <Input
                  placeholder="Display name"
                  value={displayName}
                  onChange={setDisplayName}
                />
                <Input
                  placeholder="Description"
                  value={description}
                  onChange={setDescription}
                />
                <select
                  className="w-full rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm"
                  value={docType}
                  onChange={(e) => setDocType(e.target.value)}
                >
                  <option value="generic">generic</option>
                  <option value="invoice">invoice</option>
                  <option value="receipt">receipt</option>
                  <option value="w2">w-2</option>
                  <option value="1099">1099</option>
                  <option value="contract">contract</option>
                  <option value="form">form</option>
                </select>
                <button
                  onClick={saveTemplate}
                  disabled={saving || !templateName.trim() || fields.length === 0}
                  className="w-full rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2.5 font-semibold disabled:opacity-40"
                >
                  {saving ? "Saving…" : `Save template (${fields.length} fields)`}
                </button>
              </div>

              {selected && (
                <div className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs uppercase tracking-wider text-blue-400">Selected field</div>
                    <button
                      onClick={() => {
                        setFields((f) => f.filter((_, i) => i !== selectedIdx));
                        setSelectedIdx(null);
                      }}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </div>
                  <Input
                    placeholder="Slug"
                    value={selected.name}
                    onChange={(v) => updateSelected(fields, setFields, selectedIdx, { name: v })}
                  />
                  <Input
                    placeholder="Label"
                    value={selected.label}
                    onChange={(v) => updateSelected(fields, setFields, selectedIdx, { label: v })}
                  />
                  <select
                    className="w-full rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm"
                    value={selected.type}
                    onChange={(e) => updateSelected(fields, setFields, selectedIdx, { type: e.target.value as FieldType })}
                  >
                    {(["text", "number", "currency", "date", "email", "phone", "table", "boolean"] as FieldType[]).map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.required}
                      onChange={(e) => updateSelected(fields, setFields, selectedIdx, { required: e.target.checked })}
                    />
                    Required
                  </label>
                  <Input
                    placeholder="Anchor text (nearby label, optional)"
                    value={selected.anchor_text || ""}
                    onChange={(v) => updateSelected(fields, setFields, selectedIdx, { anchor_text: v })}
                  />
                  <div className="text-[11px] text-zinc-500 font-mono">
                    bbox: [{selected.bbox.map((n) => n.toFixed(0)).join(", ")}]
                  </div>
                </div>
              )}

              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
                <div className="text-xs uppercase tracking-wider text-zinc-500 mb-3">Fields ({fields.length})</div>
                <div className="space-y-1 max-h-64 overflow-auto">
                  {fields.map((f, i) => (
                    <button
                      key={i}
                      onClick={() => setSelectedIdx(i)}
                      className={`w-full text-left rounded px-2 py-1.5 text-sm flex items-center justify-between ${
                        i === selectedIdx ? "bg-blue-500/20 text-blue-200" : "hover:bg-zinc-800"
                      }`}
                    >
                      <span className="truncate">
                        {f.label}
                        {f.required && <span className="text-red-400 ml-1">*</span>}
                      </span>
                      <span className="text-[10px] text-zinc-500 ml-2">{f.type}</span>
                    </button>
                  ))}
                  {fields.length === 0 && (
                    <div className="text-xs text-zinc-600 py-4 text-center">
                      Draw a box on the page to add your first field
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function updateSelected(
  fields: TemplateField[],
  setFields: (f: TemplateField[]) => void,
  idx: number | null,
  patch: Partial<TemplateField>,
) {
  if (idx === null) return;
  setFields(fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
}

function Input({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-lg bg-zinc-900 border border-zinc-800 focus:border-blue-500 outline-none px-3 py-2 text-sm"
    />
  );
}

function SchemaFirstPanel({
  schemaFields,
  setSchemaFields,
  onComplete,
}: {
  schemaFields: Array<{ name: string; label: string; type: FieldType; required: boolean }>;
  setSchemaFields: (f: Array<{ name: string; label: string; type: FieldType; required: boolean }>) => void;
  onComplete: (fields: Array<{ name: string; label: string; type: FieldType; required: boolean }>, file: File | null) => void;
}) {
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const addField = () =>
    setSchemaFields([
      ...schemaFields,
      { name: `field_${schemaFields.length + 1}`, label: "New field", type: "text", required: false },
    ]);

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-blue-400">Schema-first mode</div>
          <h2 className="text-xl font-semibold mt-1">What data do you want to extract?</h2>
          <p className="text-sm text-zinc-400 mt-1">
            Define the fields first. Upload your doc and we&apos;ll place boxes you can drag into position.
          </p>
        </div>
        <Link href="/template/new" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← Canvas-first mode
        </Link>
      </div>

      <div className="space-y-2 mb-4">
        {schemaFields.map((f, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_120px_80px_auto] gap-2">
            <input
              value={f.name}
              onChange={(e) => {
                const next = [...schemaFields];
                next[i].name = e.target.value;
                setSchemaFields(next);
              }}
              placeholder="slug"
              className="rounded bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm"
            />
            <input
              value={f.label}
              onChange={(e) => {
                const next = [...schemaFields];
                next[i].label = e.target.value;
                setSchemaFields(next);
              }}
              placeholder="Display label"
              className="rounded bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm"
            />
            <select
              value={f.type}
              onChange={(e) => {
                const next = [...schemaFields];
                next[i].type = e.target.value as FieldType;
                setSchemaFields(next);
              }}
              className="rounded bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm"
            >
              {(["text", "number", "currency", "date", "email", "phone", "table", "boolean"] as FieldType[]).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={f.required}
                onChange={(e) => {
                  const next = [...schemaFields];
                  next[i].required = e.target.checked;
                  setSchemaFields(next);
                }}
              />
              Required
            </label>
            <button
              onClick={() => setSchemaFields(schemaFields.filter((_, j) => j !== i))}
              className="text-red-400 hover:text-red-300 text-xs"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <button
        onClick={addField}
        className="text-sm text-blue-400 hover:text-blue-300"
      >
        + Add field
      </button>

      <div className="mt-6 border-t border-zinc-800 pt-6">
        <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Next: upload the first document</div>
        <input
          type="file"
          accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg"
          onChange={(e) => setPendingFile(e.target.files?.[0] || null)}
          className="text-sm"
        />
        <button
          onClick={() => onComplete(schemaFields, pendingFile)}
          disabled={schemaFields.length === 0 || !pendingFile}
          className="ml-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 px-4 py-1.5 text-sm font-semibold"
        >
          Continue to mapping →
        </button>
      </div>
    </div>
  );
}

function FileDropzone({ onFile, parsing }: { onFile: (f: File) => void; parsing: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div
      onClick={() => ref.current?.click()}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      className="rounded-2xl border-2 border-dashed border-zinc-700 bg-zinc-900/30 hover:border-blue-500 hover:bg-zinc-900/50 p-16 text-center cursor-pointer"
    >
      <div className="text-xl font-semibold">
        {parsing ? "Parsing first document…" : "Drop your first PDF"}
      </div>
      <div className="mt-2 text-sm text-zinc-500">
        Upload any document, we&apos;ll auto-detect blocks. You label once, apply to the rest.
      </div>
      <input
        ref={ref}
        type="file"
        hidden
        accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.tiff"
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
    </div>
  );
}

export default function TemplateNewPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-zinc-950" />}>
      <TemplateNewPageInner />
    </Suspense>
  );
}
