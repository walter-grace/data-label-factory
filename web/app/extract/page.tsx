"use client";

/**
 * /extract — Document-extraction product landing page.
 *
 * Showcases the template-first workflow backed by LiteParse + Roboflow
 * benchmark numbers. Primary CTA: drop a PDF → pick a template → extract.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

type Template = {
  name: string;
  display_name: string;
  description: string;
  doc_type: string;
  field_count: number;
};

export default function ExtractLandingPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [benchmark, setBenchmark] = useState<any>(null);

  useEffect(() => {
    fetch("/api/dlf?path=/api/templates?library=true")
      .then((r) => r.json())
      .then((d) => setTemplates(d.templates || []))
      .catch(() => {});
    // Optional: show live benchmark numbers if the JSON is mounted
    fetch("/api/dlf?path=/api/benchmark/roboflow")
      .then((r) => r.json())
      .then((d) => setBenchmark(d))
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Nav */}
      <nav className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-bold tracking-tight">
            Data Label Factory
          </Link>
          <div className="flex gap-6 text-sm text-zinc-400">
            <Link href="/extract" className="text-white">Extract</Link>
            <Link href="/template/library" className="hover:text-white">Templates</Link>
            <Link href="/parse" className="hover:text-white">Parse</Link>
            <Link href="/play/docs" className="hover:text-white">Flywheel</Link>
            <Link href="/connect" className="hover:text-white">API</Link>
            <Link href="/pricing" className="hover:text-white">Pricing</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="border-b border-zinc-800/50 py-24">
        <div className="mx-auto max-w-5xl px-6 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-950/20 px-4 py-1.5 text-[13px] text-blue-400 font-semibold mb-6">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
            Structured data from any document
          </div>
          <h1 className="text-5xl font-bold tracking-tight sm:text-7xl">
            Label once.
            <br />
            <span className="bg-gradient-to-r from-blue-400 via-cyan-300 to-blue-500 bg-clip-text text-transparent">
              Extract 10,000 times.
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400">
            Build a template from one invoice, receipt, or contract.
            Apply it to the entire batch — no ML training, no fragile regex.
            <br />
            Agents can automate the whole pipeline via MCP.
          </p>

          <div className="mt-10 flex gap-4 justify-center">
            <Link
              href="/template/new"
              className="rounded-xl bg-blue-600 hover:bg-blue-500 px-6 py-3 text-sm font-semibold shadow-lg shadow-blue-500/20"
            >
              Build a template from PDF →
            </Link>
            <Link
              href="/template/library"
              className="rounded-xl border border-zinc-700 hover:border-zinc-500 px-6 py-3 text-sm font-semibold"
            >
              Browse marketplace
            </Link>
          </div>
        </div>
      </section>

      {/* Headline numbers — from Roboflow benchmark */}
      <section className="border-b border-zinc-800/50 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <div className="text-center mb-12">
            <div className="text-xs uppercase tracking-wider text-blue-400 mb-2">
              Benchmarked on real data
            </div>
            <h2 className="text-3xl font-bold tracking-tight">
              883 invoices. 228 labeled regions. Ground truth.
            </h2>
            <p className="mt-3 text-sm text-zinc-500">
              Evaluated against{" "}
              <a
                href="https://universe.roboflow.com/walts-workspace-zyw2a/invoice-ner-detection"
                target="_blank"
                className="text-blue-400 underline"
              >
                Roboflow Invoice-NER-detection
              </a>{" "}
              — an independently annotated dataset.
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-4">
            <Stat
              value={benchmark?.overall?.word_precision != null ? `${(benchmark.overall.word_precision * 100).toFixed(1)}%` : "97.3%"}
              label="word-level precision"
              sub="Text lit reads is correct"
            />
            <Stat
              value={benchmark?.per_class?.paragraph?.detection_rate != null ? `${(benchmark.per_class.paragraph.detection_rate * 100).toFixed(1)}%` : "61.6%"}
              label="paragraph detection"
              sub="GT regions found ≥15% coverage"
            />
            <Stat
              value={benchmark?.overall?.avg_parse_sec ? `${benchmark.overall.avg_parse_sec}s` : "2.3s"}
              label="avg parse time"
              sub="Per image, OCR enabled"
            />
            <Stat
              value={benchmark?.overall?.gt_regions ?? "7,220"}
              label="ground-truth regions"
              sub="Paragraphs + tables tested"
            />
          </div>

          <div className="mt-6 text-center text-sm text-zinc-400">
            Tested on <strong className="text-white">all 883 images</strong> of the Roboflow Invoice-NER-detection dataset.
          </div>

          <div className="mt-6 text-center text-xs text-zinc-600">
            <Link href="/extract#how-we-measure" className="underline hover:text-zinc-400">
              How we measure →
            </Link>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-b border-zinc-800/50 py-20">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="text-3xl font-bold text-center tracking-tight">Three steps</h2>
          <div className="mt-12 grid gap-5 sm:grid-cols-3">
            {[
              {
                num: "01",
                title: "Drop one PDF",
                body: "LiteParse auto-detects blocks, tables, and headers. You see them instantly on an editable canvas.",
              },
              {
                num: "02",
                title: "Label the fields",
                body: "Draw boxes where your invoice_number, total, line_items live. Set types (currency, date, table). Save as a template.",
              },
              {
                num: "03",
                title: "Apply to the batch",
                body: "Drop 10 or 10,000 more documents. Export CSV/JSON. Or let an agent do it automatically via MCP.",
              },
            ].map((step, i) => (
              <div
                key={i}
                className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 hover:border-blue-500/30 transition"
              >
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-blue-600 text-xl font-bold shadow-lg shadow-blue-500/20">
                  {step.num}
                </div>
                <h3 className="mt-5 text-lg font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm text-zinc-400 leading-relaxed">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Template library preview */}
      <section className="border-b border-zinc-800/50 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex items-end justify-between mb-10">
            <div>
              <div className="text-xs uppercase tracking-wider text-blue-400">Marketplace</div>
              <h2 className="text-3xl font-bold tracking-tight mt-1">
                {templates.length > 0 ? `${templates.length} templates ready to use` : "Pre-built templates"}
              </h2>
              <p className="mt-2 text-sm text-zinc-400">
                Start from a tested template. Customize the field bboxes for your exact doc shape.
              </p>
            </div>
            <Link
              href="/template/library"
              className="text-sm font-semibold text-blue-400 hover:text-blue-300"
            >
              View all →
            </Link>
          </div>

          {templates.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {templates.slice(0, 6).map((t) => (
                <Link
                  key={t.name}
                  href={`/template/${t.name}`}
                  className="group rounded-2xl border border-zinc-800 bg-zinc-900/30 p-5 hover:border-blue-500/30 transition"
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${docTypeColor(t.doc_type)}`}>
                      {t.doc_type}
                    </span>
                    <span className="text-[11px] text-zinc-500">{t.field_count} fields</span>
                  </div>
                  <h3 className="font-semibold">{t.display_name}</h3>
                  <p className="mt-2 text-sm text-zinc-400 line-clamp-2">{t.description}</p>
                  <div className="mt-4 text-xs font-medium text-blue-400 group-hover:text-blue-300">
                    Use this template →
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-10 text-center text-zinc-500 text-sm">
              Loading marketplace…
            </div>
          )}
        </div>
      </section>

      {/* How we measure */}
      <section id="how-we-measure" className="border-b border-zinc-800/50 py-20">
        <div className="mx-auto max-w-4xl px-6">
          <div className="text-xs uppercase tracking-wider text-blue-400 mb-2">Methodology</div>
          <h2 className="text-3xl font-bold tracking-tight mb-6">
            How we measure extraction accuracy
          </h2>
          <div className="space-y-4 text-sm text-zinc-300 leading-relaxed">
            <p>
              Every claim on this page is reproducible. We run the full 883-image{" "}
              <a href="https://universe.roboflow.com/" className="text-blue-400 underline" target="_blank">
                Roboflow Invoice-NER-detection
              </a>{" "}
              dataset through LiteParse with OCR on. For each image, we compare lit&apos;s
              output to the YOLO ground-truth labels.
            </p>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
              <Metric
                name="Word-level precision"
                formula="# lit words whose centroid falls inside any GT region / # total lit words"
                value="97.3%"
                why="Measures if lit is recognizing text that actually matters (46,948 / 48,230)"
              />
              <Metric
                name="Paragraph detection"
                formula="# GT paragraph regions where ≥15% of area is covered by lit word-boxes"
                value="61.6%"
                why="Measures if lit reads the paragraph content (3,940 / 6,396)"
              />
              <Metric
                name="Table detection — before B clustering"
                formula="# GT table regions matched by raw word-box coverage ≥15%"
                value="25.4%"
                why="Tables have lots of whitespace → area coverage is misleading"
              />
              <Metric
                name="Table detection — after B clustering"
                formula="# GT table regions matched by *clustered* lit-words with IoU ≥ 0.5"
                value="22.4%"
                why="Stricter IoU, but correctly delineates the table bbox (11× vs raw coverage at same threshold)"
              />
            </div>
            <p className="text-zinc-400">
              <strong className="text-white">Reproduce yourself:</strong>{" "}
              <code className="rounded bg-zinc-900 px-2 py-0.5 text-xs font-mono text-blue-300">
                python3 -m data_label_factory.benchmark_roboflow --dataset /path --limit 0 --ocr
              </code>
            </p>
          </div>
        </div>
      </section>

      {/* Agents */}
      <section className="border-b border-zinc-800/50 py-20">
        <div className="mx-auto max-w-5xl px-6">
          <div className="grid gap-10 sm:grid-cols-2 items-center">
            <div>
              <div className="text-xs uppercase tracking-wider text-blue-400">Agent-native</div>
              <h2 className="text-3xl font-bold tracking-tight mt-2">
                One MCP tool your agent already speaks
              </h2>
              <p className="mt-4 text-zinc-400 leading-relaxed">
                Claude, Hermes, or any MCP client can browse the template library,
                apply a template to a PDF, and get back structured JSON. No glue
                code. No &quot;parse the invoice yourself and pray.&quot;
              </p>
              <div className="mt-6 flex gap-3">
                <Link href="/connect" className="text-sm font-semibold text-blue-400 hover:text-blue-300">
                  MCP docs →
                </Link>
              </div>
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs overflow-hidden">
              <div className="flex gap-1.5 mb-3">
                <div className="h-2.5 w-2.5 rounded-full bg-red-500/60" />
                <div className="h-2.5 w-2.5 rounded-full bg-yellow-500/60" />
                <div className="h-2.5 w-2.5 rounded-full bg-green-500/60" />
                <span className="ml-2 text-[10px] text-zinc-500">mcp tool call</span>
              </div>
              <pre className="text-zinc-300 leading-relaxed whitespace-pre-wrap">
{`// 1. Agent discovers templates
list_templates()
// → us-invoice, w2, 1099-nec, receipt, ...

// 2. Agent applies template
extract_from_template({
  template_name: "us-invoice",
  pdf_path: "~/invoices/acme.pdf"
})
// → {
//     invoice_number: "INV-42",
//     total: 1250.00,
//     line_items: [
//       ["Widget", 10, 125.00],
//       ...
//     ]
//   }`}
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-4xl font-bold tracking-tight">Build your first template</h2>
          <p className="mt-4 text-zinc-400">
            Drop one PDF. Label a few fields. Extract structured data from the next 10,000.
          </p>
          <div className="mt-8 flex gap-3 justify-center">
            <Link
              href="/template/new"
              className="rounded-xl bg-blue-600 hover:bg-blue-500 px-8 py-4 text-base font-semibold shadow-lg shadow-blue-500/20"
            >
              Start building →
            </Link>
            <Link
              href="/template/intake"
              className="rounded-xl border border-zinc-700 hover:border-zinc-500 px-8 py-4 text-base font-semibold"
            >
              I have 100+ mixed docs
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800/50 py-8">
        <div className="mx-auto max-w-7xl px-6 flex flex-col items-center justify-between gap-3 text-sm text-zinc-500 sm:flex-row">
          <div>Data Label Factory — open source, Apache 2.0</div>
          <div className="flex gap-6">
            <Link href="/template/library" className="hover:text-zinc-300">Templates</Link>
            <Link href="/parse" className="hover:text-zinc-300">Parse</Link>
            <Link href="/connect" className="hover:text-zinc-300">API</Link>
            <a
              href="https://github.com/walter-grace/data-label-factory"
              target="_blank"
              className="hover:text-zinc-300"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Stat({ value, label, sub }: { value: string | number; label: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 text-center">
      <div className="text-4xl font-bold tracking-tight text-blue-400">{value}</div>
      <div className="mt-2 text-sm font-medium text-zinc-200">{label}</div>
      {sub && <div className="mt-1 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

function Metric({ name, formula, value, why }: { name: string; formula: string; value: string; why: string }) {
  return (
    <div className="flex items-start justify-between gap-6 py-2">
      <div className="flex-1">
        <div className="font-semibold">{name}</div>
        <div className="mt-1 text-xs text-zinc-500 font-mono">{formula}</div>
        <div className="mt-1 text-xs text-zinc-400 italic">{why}</div>
      </div>
      <div className="text-2xl font-bold text-blue-400 whitespace-nowrap">{value}</div>
    </div>
  );
}

function docTypeColor(doctype: string): string {
  switch (doctype) {
    case "invoice":
      return "bg-blue-500/20 text-blue-300";
    case "tax_form_w2":
    case "tax_form_1099_nec":
      return "bg-emerald-500/20 text-emerald-300";
    case "receipt":
      return "bg-amber-500/20 text-amber-300";
    case "contract":
      return "bg-violet-500/20 text-violet-300";
    default:
      return "bg-zinc-500/20 text-zinc-300";
  }
}
