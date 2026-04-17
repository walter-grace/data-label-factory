"use client";

/**
 * /template/library — Template Marketplace
 *
 * Users land here when they want to skip labeling from scratch. They
 * pick a pre-built template (US Invoice, W-2, 1099-NEC, etc.) and get
 * redirected to the editor at `/template/new?base=<name>` where they
 * fine-tune the field bboxes on their own documents.
 *
 * Data source: GET /api/templates?library=true (proxied via /api/dlf).
 * The endpoint returns summary shape — we don't pull full field
 * definitions here because the card doesn't need them.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type TemplateSummary = {
  name: string;
  display_name: string;
  description: string;
  doc_type: string;
  field_count: number;
  page_size: [number, number];
  source: string;
};

type ListResponse = {
  templates?: TemplateSummary[];
  source?: string;
  error?: string;
  detail?: string;
};

const DLF_PROXY = "/api/dlf";

// Stable ordering for the marketplace cards. Templates not in this list
// fall through to the end in the order the backend returns them.
const FEATURED_ORDER = [
  "us-invoice",
  "w2",
  "1099-nec",
  "receipt",
  "service-agreement",
];

// Doc-type badge colors — blue-family palette matching the dark theme.
const DOC_TYPE_COLORS: Record<string, string> = {
  invoice: "bg-blue-500/10 text-blue-300 border-blue-500/30",
  tax_form_w2: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  tax_form_1099_nec: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  receipt: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  contract: "bg-violet-500/10 text-violet-300 border-violet-500/30",
};

function badgeClass(docType: string): string {
  return (
    DOC_TYPE_COLORS[docType] ||
    "bg-zinc-500/10 text-zinc-300 border-zinc-600/40"
  );
}

// Render doc_type in a readable form — "tax_form_w2" → "Tax Form W-2"
function prettyDocType(t: string): string {
  const special: Record<string, string> = {
    tax_form_w2: "Tax Form W-2",
    tax_form_1099_nec: "Tax Form 1099-NEC",
  };
  if (special[t]) return special[t];
  return t
    .split(/[_-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

export default function TemplateLibraryPage() {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${DLF_PROXY}?path=/api/templates&library=true`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: ListResponse) => {
        if (cancelled) return;
        if (data.error || data.detail) {
          setError(data.error || data.detail || "Unknown error");
          setTemplates([]);
        } else {
          setTemplates(data.templates || []);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(`Could not reach backend: ${e.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedTemplates = useMemo(() => {
    const indexOf = (name: string) => {
      const i = FEATURED_ORDER.indexOf(name);
      return i === -1 ? FEATURED_ORDER.length + 1 : i;
    };
    return [...templates].sort((a, b) => {
      const da = indexOf(a.name);
      const db = indexOf(b.name);
      if (da !== db) return da - db;
      return a.display_name.localeCompare(b.display_name);
    });
  }, [templates]);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Nav */}
      <nav className="sticky top-0 z-50 w-full border-b border-white/5 bg-zinc-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-black">
              DLF
            </div>
            <span className="text-sm font-semibold tracking-tight">
              Data Label Factory
            </span>
          </Link>
          <div className="hidden items-center gap-8 text-sm text-zinc-400 sm:flex">
            <Link href="/build" className="transition hover:text-white">Build</Link>
            <Link href="/train" className="transition hover:text-white">Train</Link>
            <Link href="/label" className="transition hover:text-white">Label</Link>
            <Link href="/parse" className="transition hover:text-white">Parse</Link>
            <Link href="/deploy" className="transition hover:text-white">Deploy</Link>
            <Link href="/pricing" className="transition hover:text-white">Pricing</Link>
            <a
              href="https://github.com/walter-grace/data-label-factory"
              target="_blank"
              className="transition hover:text-white"
            >
              GitHub
            </a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="border-b border-zinc-900/80 bg-gradient-to-b from-blue-950/30 to-zinc-950">
        <div className="mx-auto max-w-6xl px-6 pt-20 pb-14 text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-300">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
            Template Marketplace
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Start from a proven template
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-zinc-400">
            Pre-built extractors for the documents you already work with —
            invoices, W-2s, 1099s, receipts, service agreements. Drop in your
            own PDFs, tweak the bboxes, and you're extracting structured data
            in minutes instead of labeling from scratch.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/template/new"
              className="rounded-xl border border-zinc-700 bg-zinc-900/60 px-5 py-2.5 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800"
            >
              Start blank
            </Link>
            <a
              href="#library"
              className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500"
            >
              Browse templates
            </a>
          </div>
        </div>
      </section>

      {/* Library grid */}
      <section id="library" className="mx-auto max-w-6xl px-6 py-16">
        <div className="mb-8 flex items-end justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Library</h2>
            <p className="mt-1 text-sm text-zinc-400">
              {loading
                ? "Loading templates…"
                : `${sortedTemplates.length} template${sortedTemplates.length === 1 ? "" : "s"} ready to use`}
            </p>
          </div>
          <div className="hidden text-xs text-zinc-500 sm:block">
            Need something custom?{" "}
            <Link href="/template/new" className="text-blue-400 hover:text-blue-300">
              Build your own
            </Link>
          </div>
        </div>

        {error && (
          <div className="mb-8 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            <div className="font-semibold">Could not load templates</div>
            <div className="mt-1 text-red-300/80">{error}</div>
          </div>
        )}

        {loading && !error && (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-56 animate-pulse rounded-2xl border border-zinc-800 bg-zinc-900/40"
              />
            ))}
          </div>
        )}

        {!loading && !error && sortedTemplates.length === 0 && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-10 text-center">
            <div className="text-lg font-semibold">No templates yet</div>
            <div className="mt-1 text-sm text-zinc-500">
              Run the backend at http://127.0.0.1:8400 and make sure{" "}
              <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">
                data_label_factory/templates/library/
              </code>{" "}
              has YAML files.
            </div>
          </div>
        )}

        {!loading && sortedTemplates.length > 0 && (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {sortedTemplates.map((t) => (
              <TemplateCard key={t.name} template={t} />
            ))}
          </div>
        )}

        {/* How it works */}
        <div className="mt-20 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-8">
          <h3 className="text-lg font-semibold">How templates work</h3>
          <div className="mt-5 grid gap-6 text-sm text-zinc-400 sm:grid-cols-3">
            <div>
              <div className="mb-2 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600/20 text-xs font-bold text-blue-300">
                1
              </div>
              <div className="font-semibold text-zinc-200">Pick a template</div>
              <div className="mt-1 leading-relaxed">
                Each template has labeled field regions for a common
                document type. Start here instead of drawing every bbox.
              </div>
            </div>
            <div>
              <div className="mb-2 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600/20 text-xs font-bold text-blue-300">
                2
              </div>
              <div className="font-semibold text-zinc-200">Tune to your docs</div>
              <div className="mt-1 leading-relaxed">
                Drag bboxes until they align with your layout. Anchor text
                lets the template adapt to doc-to-doc variance.
              </div>
            </div>
            <div>
              <div className="mb-2 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600/20 text-xs font-bold text-blue-300">
                3
              </div>
              <div className="font-semibold text-zinc-200">Apply to batches</div>
              <div className="mt-1 leading-relaxed">
                Upload N PDFs and extract structured JSON/CSV. Corrections
                flow back into the training loop.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800/50 py-8 mt-4">
        <div className="mx-auto max-w-6xl px-6 flex flex-col items-center justify-between gap-4 text-sm text-zinc-500 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-[8px] font-black text-white">
              DLF
            </div>
            <span>Data Label Factory</span>
          </div>
          <div className="flex gap-6">
            <Link href="/build" className="transition hover:text-zinc-300">Build</Link>
            <Link href="/train" className="transition hover:text-zinc-300">Train</Link>
            <Link href="/deploy" className="transition hover:text-zinc-300">Deploy</Link>
            <Link href="/label" className="transition hover:text-zinc-300">Label</Link>
            <Link href="/parse" className="transition hover:text-zinc-300">Parse</Link>
            <a
              href="https://github.com/walter-grace/data-label-factory"
              target="_blank"
              className="transition hover:text-zinc-300"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Template card                                                       */
/* ------------------------------------------------------------------ */

function TemplateCard({ template }: { template: TemplateSummary }) {
  const [w, h] = template.page_size || [612, 792];
  const orientation = w > h ? "Landscape" : "Portrait";

  return (
    <div className="group relative flex flex-col rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 transition hover:border-blue-500/40 hover:bg-zinc-900/70">
      {/* Header: name + doc-type badge */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-semibold leading-tight text-zinc-100">
            {template.display_name}
          </h3>
          <div className="mt-1 font-mono text-xs text-zinc-500">
            {template.name}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${badgeClass(
            template.doc_type,
          )}`}
        >
          {prettyDocType(template.doc_type)}
        </span>
      </div>

      {/* Description */}
      <p className="mt-4 flex-1 text-sm leading-relaxed text-zinc-400 line-clamp-3">
        {template.description || "No description."}
      </p>

      {/* Stats */}
      <div className="mt-5 grid grid-cols-3 gap-3 border-t border-zinc-800/80 pt-4 text-xs">
        <Stat label="Fields" value={String(template.field_count)} />
        <Stat label="Page" value={`${w}×${h}`} mono />
        <Stat label="Layout" value={orientation} />
      </div>

      {/* CTA */}
      <Link
        href={`/template/new?base=${encodeURIComponent(template.name)}`}
        className="mt-5 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 group-hover:shadow-lg group-hover:shadow-blue-600/20"
      >
        Use template
        <span aria-hidden="true" className="transition group-hover:translate-x-0.5">
          →
        </span>
      </Link>
    </div>
  );
}

function Stat({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
      </div>
      <div
        className={`mt-0.5 text-zinc-200 ${mono ? "font-mono text-xs" : "text-sm font-medium"}`}
      >
        {value}
      </div>
    </div>
  );
}
