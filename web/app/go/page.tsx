"use client";

/**
 * /go — The dead-simple one-page DLF experience.
 *
 * Flow:
 *   1. DROP    — user drops files (any type)
 *   2. DETECT  — auto-parse + cluster → we tell them what we found
 *   3. LABEL   — pipeline runs, progress shown live
 *   4. REVIEW  — user sees results, can correct → corrections feed Flywheel
 *   5. EXPORT  — download YOLO / COCO / CSV
 *
 * Chat agent sidebar guides the user through every step.
 * No nav decisions. No template selection. No config screens.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";

// ── Types ────────────────────────────────────────────────────

type Stage = "drop" | "detecting" | "detected" | "labeling" | "review" | "export";

type DetectedDoc = {
  filename: string;
  text_length: number;
  block_count: number;
  page_count: number;
  elapsed_ms: number;
  text_preview: string;
  doc_type_guess: string;
};

type LabeledField = {
  name: string;
  value: any;
  raw_text: string;
  confidence: number;
  bbox: number[];
};

type BboxAnnotation = {
  bbox: [number, number, number, number]; // [x, y, w, h] in pixels
  category: string;
  score: number;
  pass_rate?: number;
};

type ProcessedDoc = {
  filename: string;
  fields: Record<string, LabeledField>;
  template_used: string;
  elapsed_ms: number;
  error?: string;
  // Vision labeling (DDG gather path)
  image_url?: string;
  image_size?: [number, number]; // [w, h]
  annotations?: BboxAnnotation[];
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};

// ── Chat helpers ─────────────────────────────────────────────

type StreamEvent = { type: string; content?: string; tool?: string; result?: string; error?: string };

async function streamChat(
  messages: Array<{ role: string; content: string }>,
  onChunk: (text: string) => void,
  onDone: () => void,
) {
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (!res.ok || !res.body) {
      onChunk("Sorry, I couldn't connect to the assistant.");
      onDone();
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const ev: StreamEvent = JSON.parse(line.slice(6));
          if (ev.type === "text" && ev.content) onChunk(ev.content);
          if (ev.type === "error") onChunk(`\n*Error: ${ev.error}*`);
        } catch {}
      }
    }
  } catch {
    onChunk("Connection error.");
  }
  onDone();
}

// ── Main page ────────────────────────────────────────────────

export default function GoPage() {
  const [stage, setStage] = useState<Stage>("drop");
  const [files, setFiles] = useState<File[]>([]);
  const [detected, setDetected] = useState<DetectedDoc[]>([]);
  const [processed, setProcessed] = useState<ProcessedDoc[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [gatheredImages, setGatheredImages] = useState<Array<{ filename: string; url: string; path: string }>>([]);
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [labelBackend, setLabelBackend] = useState<string>("openrouter");
  const [availableBackends, setAvailableBackends] = useState<Array<{ name: string; alive: boolean; caps: string[] }>>([]);
  const [swarmRequested, setSwarmRequested] = useState(false);
  const [swarmResult, setSwarmResult] = useState<{ ok: boolean; reason?: string; post_id?: string } | null>(null);

  // Chat state
  const [chatOpen, setChatOpen] = useState(true);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Hi! Drop your files on the left and I'll guide you through the labeling process. I can also answer questions about templates, the Flywheel game, or how to connect your agent.",
    },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages]);

  // Auto-detect available labeling backends on load
  useEffect(() => {
    fetch("/api/providers")
      .then((r) => r.json())
      .then((d) => {
        const providers = (d.providers || []).map((p: any) => ({
          name: p.name,
          alive: p.alive,
          caps: p.capabilities || [],
        }));
        setAvailableBackends(providers);
        // Pick best available label backend: falcon > flywheel > openrouter
        const falcon = providers.find((p: any) => p.name === "falcon" && p.alive && p.caps.includes("label"));
        const flywheel = providers.find((p: any) => p.name === "flywheel" && p.alive && p.caps.includes("label"));
        const openrouter = providers.find((p: any) => p.name === "openrouter" && p.alive && p.caps.includes("label"));
        if (falcon) {
          setLabelBackend("falcon");
          addSystemChat("Falcon Perception detected — using precise bbox labeling.");
        } else if (openrouter) {
          setLabelBackend("openrouter");
        }
      })
      .catch(() => {});
  }, []);

  // Lightbox keyboard nav
  useEffect(() => {
    if (lightbox === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
      if (e.key === "ArrowLeft" && lightbox > 0) setLightbox(lightbox - 1);
      if (e.key === "ArrowRight" && lightbox < processed.length - 1) setLightbox(lightbox + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, processed.length]);

  // ── Auto-post to community ──
  const autoPostToCommunity = (query: string, imageCount: number) => {
    fetch("/api/community/auto-post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, image_count: imageCount }),
    }).catch(() => {});
  };

  // ── Chat send ──
  const sendChat = useCallback(
    async (text: string) => {
      if (!text.trim() || chatStreaming) return;
      const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: "user", content: text.trim() };
      const updated = [...chatMessages, userMsg];
      setChatMessages(updated);
      setChatInput("");
      setChatStreaming(true);

      let accumulated = "";
      await streamChat(
        updated.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
        (chunk) => {
          accumulated += chunk;
          setChatMessages((prev) => {
            const without = prev.filter((m) => m.id !== "streaming");
            return [...without, { id: "streaming", role: "assistant", content: accumulated }];
          });
        },
        () => {
          setChatMessages((prev) => {
            const without = prev.filter((m) => m.id !== "streaming");
            return [...without, { id: `a-${Date.now()}`, role: "assistant", content: accumulated }];
          });
          setChatStreaming(false);
        },
      );
    },
    [chatMessages, chatStreaming],
  );

  // Auto-chat when stage changes
  const addSystemChat = useCallback((msg: string) => {
    setChatMessages((prev) => [
      ...prev,
      { id: `s-${Date.now()}`, role: "assistant", content: msg },
    ]);
  }, []);

  // ── Step 0: Search + gather ──
  const searchAndGather = async () => {
    if (!searchQuery.trim() || searching) return;
    setSearching(true);
    setError(null);
    addSystemChat(`Searching for **"${searchQuery}"** images...`);

    try {
      const r = await fetch("/api/gather", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery.trim(), max_images: 15 }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.detail || data.error || "search failed");
        addSystemChat(`Search failed: ${data.detail || data.error || "unknown error"}`);
        setSearching(false);
        return;
      }
      const gathered = data.images || [];
      const sourceLabel = data.upstream === "ddg-mini" ? "DuckDuckGo" : data.upstream === "wikimedia" ? "Wikimedia Commons" : data.upstream;
      if (sourceLabel && gathered.length > 0) addSystemChat(`Pulled results from ${sourceLabel}.`);

      setGatheredImages(gathered);

      if (gathered.length === 0) {
        addSystemChat(`No images found for "${searchQuery}". Try a different description.`);
        setSearching(false);
        return;
      }

      addSystemChat(
        `Found **${gathered.length} images** for "${searchQuery}". ` +
        `Now labeling each image with bounding boxes...`,
      );

      // Auto-proceed to labeling — run bbox detection on each gathered image
      setStage("labeling");
      setProcessed([]);
      setProgress({ done: 0, total: gathered.length, current: "" });

      const results: ProcessedDoc[] = [];
      for (let i = 0; i < gathered.length; i++) {
        const img = gathered[i];
        setProgress({ done: i, total: gathered.length, current: img.filename });

        try {
          // Call /api/label-path with the best available backend
          const labelRes = await fetch("/api/label-path", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              path: img.path,
              queries: searchQuery,
              backend: labelBackend,
            }),
          });
          const labelData = await labelRes.json();

          const annotations: BboxAnnotation[] = (labelData.annotations || []).map((a: any) => ({
            bbox: a.bbox,
            category: a.category || searchQuery,
            score: a.score || 0,
            pass_rate: a.pass_rate,
          }));

          results.push({
            filename: img.filename,
            fields: {
              source_url: { name: "source_url", value: img.url, raw_text: img.url, confidence: 1, bbox: [0,0,0,0] },
              detections: { name: "detections", value: annotations.length, raw_text: `${annotations.length} bbox(es)`, confidence: 1, bbox: [0,0,0,0] },
            },
            template_used: `ddg:${searchQuery}`,
            elapsed_ms: labelData.elapsed ? labelData.elapsed * 1000 : 0,
            image_url: img.url,
            image_size: labelData.image_size || [640, 640],
            annotations,
          });

          // Update results in real-time so user sees progress
          setProcessed([...results]);
        } catch (e: any) {
          results.push({
            filename: img.filename,
            fields: {},
            template_used: `ddg:${searchQuery}`,
            elapsed_ms: 0,
            image_url: img.url,
            error: e.message,
          });
          setProcessed([...results]);
        }
      }

      setProgress({ done: gathered.length, total: gathered.length, current: "" });
      setStage("review");

      const ok = results.filter((r) => !r.error).length;
      const totalBboxes = results.reduce((s, r) => s + (r.annotations?.length || 0), 0);
      addSystemChat(
        `Labeled **${ok}/${results.length}** images with **${totalBboxes} bounding boxes**. ` +
        `Review the results — green boxes show detected ${searchQuery}. Export as COCO/CSV when ready.`,
      );
      // Auto-post labeling job to community
      autoPostToCommunity(searchQuery, ok);
    } catch (e: any) {
      setError(`Search failed: ${e.message}`);
    } finally {
      setSearching(false);
    }
  };

  // ── Step 1: Drop ──
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const dropped = Array.from(e.dataTransfer.files);
      if (dropped.length > 0) {
        setFiles(dropped);
        detectFiles(dropped);
      }
    },
    [],
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length > 0) {
      setFiles(picked);
      detectFiles(picked);
    }
  };

  // ── Step 2: Detect ──
  const detectFiles = async (fileList: File[]) => {
    setStage("detecting");
    setError(null);
    setDetected([]);
    addSystemChat(`Analyzing ${fileList.length} file${fileList.length > 1 ? "s" : ""}...`);

    const results: DetectedDoc[] = [];
    for (const f of fileList) {
      try {
        const form = new FormData();
        form.append("file", f);
        form.append("backend", "liteparse");
        form.append("ocr", "false");

        const res = await fetch("/api/parse", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) {
          results.push({
            filename: f.name,
            text_length: 0,
            block_count: 0,
            page_count: 0,
            elapsed_ms: 0,
            text_preview: "",
            doc_type_guess: "error",
          });
          continue;
        }

        // Guess doc type from content
        const text = (data.text || "").toLowerCase();
        let guess = "document";
        if (text.includes("invoice") || text.includes("bill to")) guess = "invoice";
        else if (text.includes("receipt") || text.includes("subtotal")) guess = "receipt";
        else if (text.includes("w-2") || text.includes("wage")) guess = "w2";
        else if (text.includes("1099")) guess = "1099";
        else if (text.includes("agreement") || text.includes("contract")) guess = "contract";
        else if (text.includes("resume") || text.includes("experience")) guess = "resume";

        results.push({
          filename: f.name,
          text_length: (data.text || "").length,
          block_count: (data.pages || []).reduce((s: number, p: any) => s + (p.blocks?.length || 0), 0),
          page_count: (data.pages || []).length,
          elapsed_ms: data.elapsed_ms || 0,
          text_preview: (data.text || "").slice(0, 200),
          doc_type_guess: guess,
        });
      } catch (e: any) {
        results.push({
          filename: f.name,
          text_length: 0,
          block_count: 0,
          page_count: 0,
          elapsed_ms: 0,
          text_preview: "",
          doc_type_guess: "error",
        });
      }
    }

    setDetected(results);
    setStage("detected");

    // Summarize in chat
    const types = results.map((r) => r.doc_type_guess);
    const uniqueTypes = [...new Set(types.filter((t) => t !== "error"))];
    const errorCount = types.filter((t) => t === "error").length;
    let summary = `Found **${results.length} document${results.length > 1 ? "s" : ""}**`;
    if (uniqueTypes.length > 0) {
      summary += ` — detected as: ${uniqueTypes.join(", ")}`;
    }
    if (errorCount > 0) summary += ` (${errorCount} failed to parse)`;
    summary += `. Click **"Label all"** to run the extraction pipeline, or ask me if you want to adjust anything first.`;
    addSystemChat(summary);
  };

  // ── Step 3: Label ──
  const labelAll = async () => {
    setStage("labeling");
    setProcessed([]);
    setProgress({ done: 0, total: files.length, current: "" });
    addSystemChat(`Running the labeling pipeline on ${files.length} files...`);

    const results: ProcessedDoc[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const det = detected[i];
      setProgress({ done: i, total: files.length, current: f.name });

      // Pick the best template based on detected type
      const templateMap: Record<string, string> = {
        invoice: "us-invoice",
        receipt: "receipt",
        w2: "w2",
        "1099": "1099-nec",
        contract: "service-agreement",
      };
      const templateName = templateMap[det?.doc_type_guess || ""] || "";

      if (templateName) {
        // Template-based extraction
        try {
          const form = new FormData();
          form.append("file", f);
          form.append("template_name", templateName);
          form.append("library", "true");

          const res = await fetch("/api/template-extract", {
            method: "POST",
            body: form,
          });
          const data = await res.json();
          results.push({
            filename: f.name,
            fields: data.fields || {},
            template_used: templateName,
            elapsed_ms: data.elapsed_ms || 0,
            error: !res.ok ? data.detail || data.error : undefined,
          });
        } catch (e: any) {
          results.push({
            filename: f.name,
            fields: {},
            template_used: templateName,
            elapsed_ms: 0,
            error: e.message,
          });
        }
      } else {
        // Raw parse — no template match, just extract text + blocks
        try {
          const form = new FormData();
          form.append("file", f);
          form.append("backend", "liteparse");
          const res = await fetch("/api/parse", { method: "POST", body: form });
          const data = await res.json();
          results.push({
            filename: f.name,
            fields: {
              full_text: {
                name: "full_text",
                value: (data.text || "").slice(0, 2000),
                raw_text: data.text || "",
                confidence: 1,
                bbox: [0, 0, 0, 0],
              },
              block_count: {
                name: "block_count",
                value: (data.pages || []).reduce((s: number, p: any) => s + (p.blocks?.length || 0), 0),
                raw_text: "",
                confidence: 1,
                bbox: [0, 0, 0, 0],
              },
            },
            template_used: "raw-parse",
            elapsed_ms: data.elapsed_ms || 0,
          });
        } catch (e: any) {
          results.push({
            filename: f.name,
            fields: {},
            template_used: "raw-parse",
            elapsed_ms: 0,
            error: e.message,
          });
        }
      }
    }

    setProcessed(results);
    setProgress({ done: files.length, total: files.length, current: "" });
    setStage("review");

    const successCount = results.filter((r) => !r.error).length;
    addSystemChat(
      `Done! **${successCount}/${results.length}** processed successfully. ` +
        `Review the results below — any corrections you make will feed the Flywheel training loop. ` +
        `When you're happy, click **"Export"**.`,
    );
  };

  // ── Step 5: Export ──
  const exportCSV = () => {
    if (processed.length === 0) return;
    // Collect all field names across all docs
    const allFields = new Set<string>();
    processed.forEach((p) => Object.keys(p.fields).forEach((k) => allFields.add(k)));
    const fieldNames = Array.from(allFields);

    const header = ["filename", "template", ...fieldNames, "elapsed_ms", "error"].join(",");
    const rows = processed.map((p) => {
      const cells = [
        csvCell(p.filename),
        p.template_used,
        ...fieldNames.map((f) => csvCell(String(p.fields[f]?.value ?? ""))),
        String(p.elapsed_ms),
        csvCell(p.error || ""),
      ];
      return cells.join(",");
    });
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    downloadBlob(blob, `dlf-export-${Date.now()}.csv`);
    addSystemChat("CSV exported. You can also create a custom template at `/template/new` for more precise field extraction next time.");
  };

  const exportJSON = () => {
    const blob = new Blob(
      [JSON.stringify({ exported_at: new Date().toISOString(), documents: processed }, null, 2)],
      { type: "application/json" },
    );
    downloadBlob(blob, `dlf-export-${Date.now()}.json`);
  };

  const exportCOCO = () => {
    // Build COCO-format annotations from the labeled images
    const categories = new Map<string, number>();
    let catId = 1;
    const images: any[] = [];
    const annotations: any[] = [];
    let annId = 1;

    processed.forEach((p, i) => {
      if (!p.annotations?.length || !p.image_size) return;
      const [w, h] = p.image_size;
      images.push({
        id: i + 1,
        file_name: p.filename,
        width: w,
        height: h,
        url: p.image_url || "",
      });
      for (const ann of p.annotations) {
        if (!categories.has(ann.category)) {
          categories.set(ann.category, catId++);
        }
        annotations.push({
          id: annId++,
          image_id: i + 1,
          category_id: categories.get(ann.category),
          bbox: ann.bbox, // [x, y, w, h]
          area: ann.bbox[2] * ann.bbox[3],
          score: ann.score,
          iscrowd: 0,
        });
      }
    });

    const coco = {
      info: { description: `DLF export — ${searchQuery}`, date_created: new Date().toISOString() },
      images,
      annotations,
      categories: Array.from(categories.entries()).map(([name, id]) => ({
        id,
        name,
        supercategory: "object",
      })),
    };
    const blob = new Blob([JSON.stringify(coco, null, 2)], { type: "application/json" });
    downloadBlob(blob, `dlf-coco-${Date.now()}.json`);
    addSystemChat(`Exported **COCO dataset** with ${annotations.length} annotations across ${images.length} images. Ready for YOLO training!`);
  };

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <div className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
          <Link href="/" className="text-lg font-bold tracking-tight">
            Data Label Factory
          </Link>
          <div className="flex items-center gap-3">
            <StageIndicator stage={stage} />
            {/* Backend badge — shows what's labeling, click to switch */}
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden text-[11px]">
              {availableBackends
                .filter((b) => b.caps.includes("label"))
                .map((b) => (
                  <button
                    key={b.name}
                    onClick={() => { if (b.alive) setLabelBackend(b.name); }}
                    className={`px-2 py-1 ${
                      labelBackend === b.name
                        ? b.alive
                          ? "bg-emerald-600/30 text-emerald-300"
                          : "bg-red-600/30 text-red-300"
                        : b.alive
                          ? "text-zinc-400 hover:text-white"
                          : "text-zinc-600 line-through"
                    }`}
                    title={b.alive ? `Use ${b.name} for labeling` : `${b.name} offline`}
                  >
                    {b.name}
                  </button>
                ))}
            </div>
            <button
              onClick={() => setChatOpen(!chatOpen)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                chatOpen ? "border-blue-500 text-blue-300" : "border-zinc-700 text-zinc-400"
              }`}
            >
              {chatOpen ? "Hide assistant" : "Show assistant"}
            </button>
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-auto p-6">
          {/* STAGE: Drop */}
          {stage === "drop" && (
            <div className="max-w-2xl mx-auto pt-12">
              <div className="text-center mb-8">
                <h1 className="text-4xl font-bold tracking-tight">
                  Drop your data.
                  <br />
                  <span className="text-zinc-400">We handle the rest.</span>
                </h1>
                <p className="mt-3 text-zinc-500">
                  Bring your own files — or just describe what to detect and we&apos;ll find images for you.
                </p>
              </div>

              {/* Two paths side by side */}
              <div className="grid gap-4 sm:grid-cols-2">
                {/* Path 1: Drop files */}
                <div
                  onDrop={handleDrop}
                  onDragOver={(e) => e.preventDefault()}
                  onClick={() => document.getElementById("go-input")?.click()}
                  className="rounded-2xl border-2 border-dashed border-zinc-700 hover:border-blue-500 bg-zinc-900/30 hover:bg-zinc-900/60 p-10 text-center cursor-pointer transition"
                >
                  <div className="text-3xl mb-3 opacity-30">+</div>
                  <div className="text-base font-medium">Drop files</div>
                  <div className="text-xs text-zinc-500 mt-2">
                    PDF, DOCX, XLSX, images
                  </div>
                  <input
                    id="go-input"
                    type="file"
                    multiple
                    hidden
                    accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.tiff,.tif"
                    onChange={handleFileInput}
                  />
                </div>

                {/* Path 2: Describe + search */}
                <div className="rounded-2xl border border-zinc-700 bg-zinc-900/30 p-6">
                  <div className="text-base font-medium mb-2">Or describe what to detect</div>
                  <div className="text-xs text-zinc-500 mb-4">
                    We&apos;ll search DuckDuckGo for images and run the full pipeline.
                  </div>
                  <form
                    onSubmit={(e) => { e.preventDefault(); searchAndGather(); }}
                    className="space-y-3"
                  >
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder='e.g. "fire hydrants in cities"'
                      disabled={searching}
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
                    />
                    <button
                      type="submit"
                      disabled={searching || !searchQuery.trim()}
                      className="w-full rounded-xl bg-blue-600 hover:bg-blue-500 px-4 py-2.5 text-sm font-semibold disabled:opacity-40"
                    >
                      {searching ? "Searching..." : "Search & Label →"}
                    </button>
                  </form>
                </div>
              </div>
            </div>
          )}

          {/* STAGE: Detecting */}
          {stage === "detecting" && (
            <div className="max-w-2xl mx-auto pt-24 text-center">
              <div className="animate-pulse text-xl font-semibold">
                Analyzing {files.length} file{files.length > 1 ? "s" : ""}...
              </div>
              <div className="mt-4 text-sm text-zinc-500">
                Parsing text, detecting layout blocks, guessing document type
              </div>
            </div>
          )}

          {/* STAGE: Detected */}
          {stage === "detected" && (
            <div className="max-w-3xl mx-auto">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-2xl font-bold">
                    {detected.length} document{detected.length > 1 ? "s" : ""} detected
                  </h2>
                  <p className="text-sm text-zinc-400 mt-1">
                    We auto-matched templates where possible. Click "Label all" to run extraction.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setStage("drop"); setFiles([]); setDetected([]); }}
                    className="rounded-xl border border-zinc-700 hover:border-zinc-500 px-4 py-2 text-sm"
                  >
                    Start over
                  </button>
                  <button
                    onClick={labelAll}
                    className="rounded-xl bg-blue-600 hover:bg-blue-500 px-6 py-2 text-sm font-semibold shadow-lg shadow-blue-500/20"
                  >
                    Label all →
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {detected.map((d, i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 flex items-center justify-between"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{d.filename}</span>
                        <TypeBadge type={d.doc_type_guess} />
                      </div>
                      <div className="text-xs text-zinc-500 mt-1">
                        {d.page_count} page{d.page_count !== 1 ? "s" : ""} · {d.block_count} blocks · {d.text_length} chars · {d.elapsed_ms}ms
                      </div>
                      {d.text_preview && (
                        <div className="text-xs text-zinc-600 mt-1 truncate max-w-lg">
                          {d.text_preview}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STAGE: Labeling — show images as they complete */}
          {stage === "labeling" && (
            <div className="max-w-5xl mx-auto">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-2xl font-bold">Labeling...</h2>
                <div className="text-sm text-zinc-400">
                  {progress.done} / {progress.total}
                  {progress.current && <span className="ml-2 text-zinc-600">— {progress.current}</span>}
                </div>
              </div>
              <div className="w-full bg-zinc-800 rounded-full h-2 mb-6">
                <div
                  className="bg-blue-500 h-2 rounded-full transition-all"
                  style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
                />
              </div>
              {/* Show completed images live */}
              {processed.length > 0 && (
                <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
                  {processed.map((p, i) => {
                    const imgUrl = p.image_url;
                    const anns = p.annotations || [];
                    const imgW = p.image_size?.[0] || 640;
                    const imgH = p.image_size?.[1] || 640;
                    return (
                      <div key={i} className="relative rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden cursor-pointer" style={{ aspectRatio: `${imgW}/${imgH}` }} onClick={() => setLightbox(i)}>
                        {imgUrl && <img src={imgUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />}
                        {anns.map((ann, j) => (
                          <div key={j} className="absolute border-2 border-emerald-400 rounded-sm" style={{ left: `${(ann.bbox[0]/imgW)*100}%`, top: `${(ann.bbox[1]/imgH)*100}%`, width: `${(ann.bbox[2]/imgW)*100}%`, height: `${(ann.bbox[3]/imgH)*100}%` }} />
                        ))}
                        <div className="absolute bottom-0 left-0 right-0 bg-black/70 p-1.5 flex justify-between text-[10px] text-white">
                          <span>{p.filename}</span>
                          {anns.length > 0 && <span className="bg-emerald-600/80 px-1.5 rounded-full">{anns.length}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* STAGE: Review */}
          {(stage === "review" || stage === "export") && (
            <div className="max-w-5xl mx-auto">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-2xl font-bold">Results</h2>
                  <p className="text-sm text-zinc-400 mt-1">
                    {processed.filter((p) => !p.error).length} / {processed.length} extracted.
                    Corrections feed the Flywheel — every edit makes the next run better.
                  </p>
                </div>
                <div className="flex gap-2">
                  {/* View toggle for gathered images */}
                  {processed.some((p) => p.template_used.startsWith("ddg:")) && (
                    <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
                      <button
                        onClick={() => setViewMode("grid")}
                        className={`px-3 py-1.5 text-xs ${viewMode === "grid" ? "bg-zinc-700 text-white" : "text-zinc-400"}`}
                      >
                        Grid
                      </button>
                      <button
                        onClick={() => setViewMode("table")}
                        className={`px-3 py-1.5 text-xs ${viewMode === "table" ? "bg-zinc-700 text-white" : "text-zinc-400"}`}
                      >
                        Table
                      </button>
                    </div>
                  )}
                  <button onClick={exportCSV} className="rounded-xl bg-blue-600 hover:bg-blue-500 px-5 py-2 text-sm font-semibold">
                    Export CSV
                  </button>
                  <button onClick={exportJSON} className="rounded-xl border border-zinc-700 hover:border-zinc-500 px-5 py-2 text-sm">
                    Export JSON
                  </button>
                  {processed.some((p) => p.annotations?.length) && (
                    <button onClick={exportCOCO} className="rounded-xl border border-emerald-600/50 hover:border-emerald-500 px-5 py-2 text-sm text-emerald-300">
                      Export COCO
                    </button>
                  )}
                  {/* Agent swarm — post to Moltbook for help labeling */}
                  {processed.length > 0 && !swarmRequested && (
                    <button
                      onClick={async () => {
                        setSwarmRequested(true);
                        try {
                          const r = await fetch("/api/moltbook/swarm", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              query: searchQuery || "data labeling",
                              image_count: processed.length,
                              play_url: `${window.location.origin}/play`,
                            }),
                          });
                          const data = await r.json();
                          setSwarmResult(data);
                          if (data.ok) {
                            addSystemChat(
                              `Posted to **Moltbook**! The agent swarm has been asked to help label ${processed.length} images of "${searchQuery}". ` +
                              `Bots will play Flywheel and their labels feed your GRPO pool.`,
                            );
                          } else {
                            addSystemChat(
                              `Swarm request couldn't post: ${data.reason || "unknown"}. ` +
                              (data.reason === "no_api_key" ? "Set DLF_MOLTBOOK_API_KEY to enable." :
                               data.reason?.includes("403") ? "Moltbook agent needs to be claimed first (post the verification tweet)." : ""),
                            );
                          }
                        } catch (e: any) {
                          setSwarmResult({ ok: false, reason: e.message });
                        }
                      }}
                      className="rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 px-5 py-2 text-sm font-semibold shadow-lg shadow-violet-500/20"
                    >
                      Request Agent Swarm
                    </button>
                  )}
                  {swarmResult && (
                    <span className={`text-xs px-2 py-1 rounded-full ${swarmResult.ok ? "bg-emerald-600/20 text-emerald-300" : "bg-amber-600/20 text-amber-300"}`}>
                      {swarmResult.ok ? "Posted to Moltbook" : swarmResult.reason?.includes("claim") ? "Pending claim" : "Pending"}
                    </span>
                  )}
                  <button
                    onClick={() => { setStage("drop"); setFiles([]); setDetected([]); setProcessed([]); setGatheredImages([]); }}
                    className="rounded-xl border border-zinc-700 hover:border-zinc-500 px-4 py-2 text-sm"
                  >
                    New batch
                  </button>
                </div>
              </div>

              {/* Image grid view for gathered results */}
              {viewMode === "grid" && processed.some((p) => p.template_used.startsWith("ddg:")) && (
                <div className="mb-6 grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
                  {processed.map((p, i) => {
                    const imgUrl = p.image_url || (p.fields.source_url?.value as string | undefined);
                    const anns = p.annotations || [];
                    const imgW = p.image_size?.[0] || 640;
                    const imgH = p.image_size?.[1] || 640;
                    return (
                      <div
                        key={i}
                        className="group relative rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden cursor-pointer hover:border-blue-500/50 transition"
                        style={{ aspectRatio: `${imgW}/${imgH}` }}
                        onClick={() => setLightbox(i)}
                      >
                        {imgUrl ? (
                          <>
                            <img
                              src={imgUrl}
                              alt={p.filename}
                              className="w-full h-full object-cover"
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display = "none";
                              }}
                            />
                            {/* Bounding box overlays */}
                            {anns.map((ann, j) => {
                              // bbox is [x, y, w, h] in pixel coords of the original image
                              // Scale to percentage for responsive overlay
                              const [bx, by, bw, bh] = ann.bbox;
                              return (
                                <div
                                  key={j}
                                  className="absolute border-2 border-emerald-400 rounded-sm"
                                  style={{
                                    left: `${(bx / imgW) * 100}%`,
                                    top: `${(by / imgH) * 100}%`,
                                    width: `${(bw / imgW) * 100}%`,
                                    height: `${(bh / imgH) * 100}%`,
                                  }}
                                >
                                  <span className="absolute -top-4 left-0 bg-emerald-600 text-white text-[8px] px-1 rounded whitespace-nowrap leading-tight">
                                    {ann.category} {(ann.score * 100).toFixed(0)}%
                                  </span>
                                </div>
                              );
                            })}
                          </>
                        ) : (
                          <div className="w-full h-full bg-zinc-800 flex items-center justify-center text-zinc-600 text-xs">
                            No image
                          </div>
                        )}
                        {/* Bottom info bar */}
                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-white truncate">{p.filename}</span>
                            {anns.length > 0 && (
                              <span className="text-[10px] bg-emerald-600/80 text-white px-1.5 rounded-full">
                                {anns.length} bbox{anns.length > 1 ? "es" : ""}
                              </span>
                            )}
                          </div>
                        </div>
                        {p.error && (
                          <div className="absolute top-1 right-1 rounded-full bg-red-500 h-3 w-3 flex items-center justify-center text-[8px] text-white">!</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Results table */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-zinc-900 text-zinc-400 sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">File</th>
                      <th className="text-left px-3 py-2 font-medium">Template</th>
                      <th className="text-left px-3 py-2 font-medium">Fields</th>
                      <th className="text-right px-3 py-2 font-medium">ms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {processed.map((p, i) => {
                      const fieldEntries = Object.entries(p.fields);
                      const imageUrl = p.fields.source_url?.value as string | undefined;
                      const isGathered = p.template_used.startsWith("ddg:");
                      return (
                        <tr key={i} className="border-t border-zinc-800 hover:bg-zinc-900/60">
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-3">
                              {isGathered && imageUrl && (
                                <img
                                  src={imageUrl}
                                  alt={p.filename}
                                  className="h-14 w-14 rounded-lg object-cover border border-zinc-700 shrink-0"
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                                />
                              )}
                              <span className="truncate max-w-[140px] text-xs">{p.filename}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <TypeBadge type={p.template_used} />
                          </td>
                          <td className="px-3 py-3">
                            {p.error ? (
                              <span className="text-red-400">{p.error}</span>
                            ) : isGathered ? (
                              <div className="text-xs text-zinc-400 truncate max-w-xs" title={imageUrl}>
                                {imageUrl?.slice(0, 60)}...
                              </div>
                            ) : (
                              <div className="space-y-1">
                                {fieldEntries.slice(0, 5).map(([key, val]) => (
                                  <div key={key} className="flex gap-2">
                                    <span className="text-zinc-500 w-28 truncate shrink-0">{key}:</span>
                                    <span className={`truncate max-w-xs ${val.confidence < 0.5 ? "text-amber-400" : "text-zinc-200"}`}>
                                      {typeof val.value === "string"
                                        ? val.value.slice(0, 60)
                                        : JSON.stringify(val.value)?.slice(0, 60)}
                                    </span>
                                  </div>
                                ))}
                                {fieldEntries.length > 5 && (
                                  <div className="text-zinc-600">+{fieldEntries.length - 5} more</div>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right text-zinc-500">{p.elapsed_ms || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {error && (
            <div className="max-w-2xl mx-auto mt-4 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
              {error}
            </div>
          )}
        </div>
      </div>

      {/* Lightbox — full-size image with bbox overlays */}
      {lightbox !== null && processed[lightbox] && (() => {
        const p = processed[lightbox];
        const imgUrl = p.image_url || (p.fields.source_url?.value as string);
        const anns = p.annotations || [];
        const imgW = p.image_size?.[0] || 640;
        const imgH = p.image_size?.[1] || 640;
        const prevIdx = lightbox > 0 ? lightbox - 1 : null;
        const nextIdx = lightbox < processed.length - 1 ? lightbox + 1 : null;
        return (
          <div
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
            onClick={() => setLightbox(null)}
          >
            <div
              className="relative max-w-[90vw] max-h-[90vh]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Close */}
              <button onClick={() => setLightbox(null)} className="absolute -top-10 right-0 text-white text-sm hover:text-zinc-300">
                Close (ESC)
              </button>

              {/* Nav arrows */}
              {prevIdx !== null && (
                <button onClick={() => setLightbox(prevIdx)} className="absolute left-[-50px] top-1/2 -translate-y-1/2 text-white text-3xl hover:text-blue-400">
                  ‹
                </button>
              )}
              {nextIdx !== null && (
                <button onClick={() => setLightbox(nextIdx)} className="absolute right-[-50px] top-1/2 -translate-y-1/2 text-white text-3xl hover:text-blue-400">
                  ›
                </button>
              )}

              {/* Image + bboxes */}
              <div className="relative">
                {imgUrl && (
                  <img
                    src={imgUrl}
                    alt={p.filename}
                    className="max-w-[85vw] max-h-[80vh] rounded-xl"
                    style={{ display: "block" }}
                  />
                )}
                {/* Bbox overlays scaled to displayed image size */}
                {anns.map((ann, j) => (
                  <div
                    key={j}
                    className="absolute border-2 border-emerald-400 rounded-sm"
                    style={{
                      left: `${(ann.bbox[0] / imgW) * 100}%`,
                      top: `${(ann.bbox[1] / imgH) * 100}%`,
                      width: `${(ann.bbox[2] / imgW) * 100}%`,
                      height: `${(ann.bbox[3] / imgH) * 100}%`,
                    }}
                  >
                    <span className="absolute -top-5 left-0 bg-emerald-600 text-white text-[11px] px-1.5 py-0.5 rounded whitespace-nowrap font-semibold shadow-lg">
                      {ann.category} {(ann.score * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>

              {/* Info bar */}
              <div className="mt-3 flex items-center justify-between text-sm text-zinc-300">
                <div>
                  <span className="font-semibold">{p.filename}</span>
                  <span className="text-zinc-500 ml-3">{imgW}×{imgH}</span>
                  <span className="text-zinc-500 ml-3">{p.elapsed_ms}ms</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="bg-emerald-600/80 text-white text-xs px-2 py-0.5 rounded-full">
                    {anns.length} detection{anns.length !== 1 ? "s" : ""}
                  </span>
                  <span className="text-zinc-500 text-xs">
                    {lightbox + 1} / {processed.length}
                  </span>
                </div>
              </div>

              {/* Annotations list */}
              {anns.length > 0 && (
                <div className="mt-3 rounded-xl bg-zinc-900/80 border border-zinc-800 p-3 max-h-32 overflow-auto">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Detections</div>
                  {anns.map((ann, j) => (
                    <div key={j} className="flex items-center justify-between text-xs py-1">
                      <div className="flex items-center gap-2">
                        <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                        <span className="text-zinc-200">{ann.category}</span>
                      </div>
                      <div className="flex gap-4 text-zinc-500">
                        <span>conf: {(ann.score * 100).toFixed(0)}%</span>
                        <span>bbox: [{ann.bbox.map((n) => Math.round(n)).join(", ")}]</span>
                        {ann.pass_rate !== undefined && (
                          <span className={ann.pass_rate >= 0.8 ? "text-emerald-400" : "text-amber-400"}>
                            QA: {(ann.pass_rate * 100).toFixed(0)}%
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Chat sidebar */}
      {chatOpen && (
        <div className="w-96 border-l border-zinc-800 flex flex-col bg-zinc-950">
          <div className="border-b border-zinc-800 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-blue-600/10 flex items-center justify-center text-blue-400 text-xs font-bold">
                AI
              </div>
              <div>
                <div className="text-sm font-semibold">DLF Assistant</div>
                <div className="text-[10px] text-zinc-500">Powered by Gemma 4</div>
              </div>
            </div>
          </div>

          <div ref={chatScrollRef} className="flex-1 overflow-auto px-4 py-4 space-y-3">
            {chatMessages.map((m) => (
              <div
                key={m.id}
                className={`text-sm leading-relaxed ${
                  m.role === "user"
                    ? "ml-8 rounded-2xl bg-blue-600 px-3 py-2 text-white"
                    : "mr-4 rounded-2xl bg-zinc-900 border border-zinc-800 px-3 py-2 text-zinc-200"
                }`}
              >
                <SimpleMarkdown text={m.content} />
              </div>
            ))}
            {chatStreaming && chatMessages[chatMessages.length - 1]?.id !== "streaming" && (
              <div className="mr-4 rounded-2xl bg-zinc-900 border border-zinc-800 px-3 py-2">
                <div className="flex gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-600 animate-bounce" />
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            )}
          </div>

          <form
            className="border-t border-zinc-800 p-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              sendChat(chatInput);
            }}
          >
            <input
              ref={inputRef}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Ask anything..."
              disabled={chatStreaming}
              className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={chatStreaming || !chatInput.trim()}
              className="rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-2 text-sm font-semibold disabled:opacity-40"
            >
              →
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────

function StageIndicator({ stage }: { stage: Stage }) {
  const stages: Array<{ key: Stage; label: string }> = [
    { key: "drop", label: "Drop" },
    { key: "detected", label: "Detect" },
    { key: "labeling", label: "Label" },
    { key: "review", label: "Review" },
    { key: "export", label: "Export" },
  ];
  const idx = stages.findIndex((s) => s.key === stage || (stage === "detecting" && s.key === "detected"));

  return (
    <div className="flex items-center gap-1 text-[11px]">
      {stages.map((s, i) => (
        <div key={s.key} className="flex items-center gap-1">
          <span
            className={`rounded-full px-2 py-0.5 font-medium ${
              i < idx
                ? "bg-emerald-600/20 text-emerald-300"
                : i === idx
                  ? "bg-blue-600/20 text-blue-300"
                  : "bg-zinc-800 text-zinc-500"
            }`}
          >
            {s.label}
          </span>
          {i < stages.length - 1 && <span className="text-zinc-700">→</span>}
        </div>
      ))}
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    invoice: "bg-blue-500/20 text-blue-300",
    receipt: "bg-amber-500/20 text-amber-300",
    w2: "bg-emerald-500/20 text-emerald-300",
    "1099": "bg-emerald-500/20 text-emerald-300",
    contract: "bg-violet-500/20 text-violet-300",
    resume: "bg-pink-500/20 text-pink-300",
    document: "bg-zinc-500/20 text-zinc-300",
    error: "bg-red-500/20 text-red-300",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${colors[type] || colors.document}`}>
      {type}
    </span>
  );
}

function SimpleMarkdown({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\n)/g);
  return (
    <span>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**")) return <strong key={i} className="font-semibold">{p.slice(2, -2)}</strong>;
        if (p.startsWith("`") && p.endsWith("`")) return <code key={i} className="rounded bg-zinc-800 px-1 text-[11px] text-blue-300">{p.slice(1, -1)}</code>;
        if (p === "\n") return <br key={i} />;
        return <span key={i}>{p}</span>;
      })}
    </span>
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
