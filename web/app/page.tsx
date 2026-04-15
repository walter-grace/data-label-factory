"use client";

import Link from "next/link";
import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import HeroAnimation from "@/components/HeroAnimation";
import ScrollReveal from "@/components/ScrollReveal";

const TYPING_EXAMPLES = [
  "stop signs",
  "fire hydrants",
  "drones on a battlefield",
  "playing cards",
  "license plates",
  "hard hats on workers",
  "ripe tomatoes",
  "potholes in roads",
  "solar panels",
  "birds in flight",
];

function useTypingPlaceholder() {
  const [placeholder, setPlaceholder] = useState("");
  const [exampleIdx, setExampleIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const example = TYPING_EXAMPLES[exampleIdx];

    if (!deleting) {
      if (charIdx < example.length) {
        const timer = setTimeout(() => setCharIdx((c) => c + 1), 60 + Math.random() * 40);
        return () => clearTimeout(timer);
      } else {
        const timer = setTimeout(() => setDeleting(true), 2000);
        return () => clearTimeout(timer);
      }
    } else {
      if (charIdx > 0) {
        const timer = setTimeout(() => setCharIdx((c) => c - 1), 30);
        return () => clearTimeout(timer);
      } else {
        setDeleting(false);
        setExampleIdx((i) => (i + 1) % TYPING_EXAMPLES.length);
      }
    }
  }, [charIdx, deleting, exampleIdx]);

  useEffect(() => {
    setPlaceholder(TYPING_EXAMPLES[exampleIdx].slice(0, charIdx));
  }, [charIdx, exampleIdx]);

  return placeholder;
}

export default function Home() {
  const [providers, setProviders] = useState<any[]>([]);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const typingPlaceholder = useTypingPlaceholder();

  useEffect(() => {
    fetch("/api/dlf?path=/api/providers")
      .then((r) => r.json())
      .then((d) => setProviders(d.providers ?? []))
      .catch(() => {});
  }, []);

  const alive = providers.filter((p) => p.alive);

  const handleGo = () => {
    if (query.trim()) {
      router.push(`/build?target=${encodeURIComponent(query.trim())}`);
    }
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Nav */}
      <nav className="fixed top-0 z-50 w-full border-b border-white/5 bg-zinc-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-black">
              DLF
            </div>
            <span className="text-sm font-semibold tracking-tight">Data Label Factory</span>
          </Link>
          <div className="hidden items-center gap-8 text-sm text-zinc-400 sm:flex">
            <Link href="/build" className="transition hover:text-white">Build</Link>
            <Link href="/train" className="transition hover:text-white">Train</Link>
            <Link href="/label" className="transition hover:text-white">Label</Link>
            <Link href="/deploy" className="transition hover:text-white">Deploy</Link>
            <Link href="/pricing" className="transition hover:text-white">Pricing</Link>
            <a href="https://github.com/walter-grace/data-label-factory" target="_blank" className="transition hover:text-white">GitHub</a>
          </div>
          {/* Mobile nav links */}
          <div className="flex items-center gap-4 text-sm text-zinc-400 sm:hidden">
            <Link href="/build" className="transition hover:text-white">Build</Link>
            <Link href="/train" className="transition hover:text-white">Train</Link>
            <Link href="/pricing" className="transition hover:text-white">Pricing</Link>
          </div>
          <Link
            href="/build"
            className="rounded-lg bg-white px-4 py-1.5 text-sm font-medium text-zinc-900 transition hover:bg-zinc-200"
          >
            Get Started
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden pt-14">
        {/* Background labeling animation */}
        <HeroAnimation />
        {/* Gradient orb */}
        <div className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 h-[600px] w-[900px] rounded-full bg-blue-600/8 blur-[120px]" />

        <div className="relative mx-auto max-w-3xl px-6 pt-20 pb-12 text-center sm:pt-28 sm:pb-16">
          {/* Status pill */}
          <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/80 px-4 py-1.5 text-[13px] text-zinc-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {alive.length > 0
              ? `${alive.length} AI backends online`
              : "Connecting to backends..."}
          </div>

          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl sm:leading-[1.1]">
            Train your agent&apos;s
            <br />
            <span className="bg-gradient-to-r from-blue-400 via-blue-300 to-cyan-400 bg-clip-text text-transparent">
              vision.
            </span>
          </h1>

          <p className="mx-auto mt-5 max-w-xl text-base text-zinc-400 sm:text-lg">
            Describe what you need to detect. Our AI pipeline builds a custom
            YOLO model — from text prompt to trained weights in minutes.
          </p>

          {/* Input box — the product IS the input */}
          <div className="mx-auto mt-10 max-w-xl">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleGo()}
              aria-label="What do you want to detect?"
              placeholder={query ? "" : typingPlaceholder || "What do you want to detect?"}
              className="h-14 w-full rounded-2xl border border-zinc-700/50 bg-zinc-900/80 px-5 text-base text-zinc-100 placeholder:text-zinc-500 shadow-lg shadow-black/20 backdrop-blur-sm focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/30 transition"
            />
            <div className="mt-4 flex items-center justify-center gap-3 text-[13px] text-zinc-500">
              {["fire hydrants", "drones", "stop signs", "playing cards"].map((ex) => (
                <button
                  key={ex}
                  onClick={() => { setQuery(ex); inputRef.current?.focus(); }}
                  className="rounded-full border border-zinc-800 px-3 py-1 transition hover:border-zinc-600 hover:text-zinc-300"
                >
                  {ex}
                </button>
              ))}
            </div>
            <div className="mt-6 flex justify-center">
              <button
                onClick={handleGo}
                className="rounded-xl bg-blue-600 px-8 py-3 text-base font-semibold text-white shadow-lg shadow-blue-600/25 transition hover:bg-blue-500 active:scale-[0.98]"
              >
                Build Model &rarr;
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Pipeline visualization */}
      <section className="border-t border-zinc-800/50 py-16">
        <div className="mx-auto max-w-4xl px-6">
          <ScrollReveal>
            <div className="text-center">
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                One command. Five stages. Zero manual work.
              </h2>
              <p className="mt-3 text-zinc-400">
                Fully automated — from description to deployable model.
              </p>
            </div>
          </ScrollReveal>

          <div className="relative mt-14">
            {/* Connection line */}
            <div className="absolute top-8 left-[10%] right-[10%] hidden h-px bg-gradient-to-r from-transparent via-zinc-700 to-transparent sm:block" />

            <div className="grid gap-8 sm:grid-cols-5">
              {[
                { num: "01", title: "Describe", desc: "Tell us what to detect", color: "from-blue-500 to-blue-600" },
                { num: "02", title: "Gather", desc: "Web search for images", color: "from-blue-500 to-blue-600" },
                { num: "03", title: "Filter", desc: "Gemma 4 verifies each", color: "from-blue-500 to-blue-600" },
                { num: "04", title: "Label", desc: "Falcon draws bboxes", color: "from-blue-500 to-blue-600" },
                { num: "05", title: "Train", desc: "YOLO model on GPU", color: "from-blue-500 to-blue-600" },
              ].map((step, i) => (
                <ScrollReveal key={i} delay={i * 0.1} direction="up">
                  <div className="text-center">
                    <div className={`mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br ${step.color} text-xl font-bold text-white shadow-lg`}>
                      {step.num}
                    </div>
                    <h3 className="mt-4 text-sm font-semibold">{step.title}</h3>
                    <p className="mt-1 text-xs text-zinc-500">{step.desc}</p>
                  </div>
                </ScrollReveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Three surfaces */}
      <section className="border-t border-zinc-800/50 py-16">
        <div className="mx-auto max-w-5xl px-6">
          <ScrollReveal>
            <div className="text-center">
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                Three ways to build
              </h2>
              <p className="mt-3 text-zinc-400">
                Website for humans. CLI for developers. MCP for AI agents.
              </p>
            </div>
          </ScrollReveal>

          <div className="mt-12 grid gap-5 sm:grid-cols-3">
            {[
              {
                title: "Website",
                subtitle: "For everyone",
                desc: "Upload images, pick a pipeline mode, download your trained YOLO model. No code needed.",
                href: "/build",
                cta: "Open Builder",
                icon: (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
                  </svg>
                ),
              },
              {
                title: "CLI",
                subtitle: "For developers",
                desc: "pip install, one command, full pipeline. Integrate into your CI/CD or research workflow.",
                href: "https://github.com/walter-grace/data-label-factory",
                cta: "View on GitHub",
                icon: (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                ),
              },
              {
                title: "MCP Server",
                subtitle: "For AI agents",
                desc: "7 tools your agent can call to build its own vision. Stripe Machine Payments for autonomous billing.",
                href: "https://github.com/walter-grace/data-label-factory#mcp-server",
                cta: "View Docs",
                icon: (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                  </svg>
                ),
              },
            ].map((item, i) => (
              <ScrollReveal key={i} delay={i * 0.12} direction="up">
              <Link
                href={item.href}
                className="group block rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6 transition hover:border-zinc-700 hover:bg-zinc-900/60"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600/10 text-blue-400">
                    {item.icon}
                  </div>
                  <div>
                    <h3 className="font-semibold">{item.title}</h3>
                    <p className="text-xs text-zinc-500">{item.subtitle}</p>
                  </div>
                </div>
                <p className="mt-4 text-sm text-zinc-400">{item.desc}</p>
                <div className="mt-4 text-sm font-medium text-blue-400 transition group-hover:text-blue-300">
                  {item.cta} &rarr;
                </div>
              </Link>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      {/* Code example */}
      <section className="border-t border-zinc-800/50 py-16">
        <div className="mx-auto max-w-4xl px-6">
          <div className="grid gap-10 sm:grid-cols-2 items-center">
            <ScrollReveal direction="left"><div>
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                Three commands.
                <br />
                <span className="text-zinc-400">That&apos;s it.</span>
              </h2>
              <p className="mt-4 text-zinc-400">
                Install, set your API key, run the pipeline. Works on Mac, Linux,
                or cloud GPU. Open source, Apache 2.0.
              </p>
              <div className="mt-6 flex gap-3">
                <Link
                  href="/build"
                  className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500"
                >
                  Try the Web UI
                </Link>
                <a
                  href="https://github.com/walter-grace/data-label-factory"
                  target="_blank"
                  className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800"
                >
                  Documentation
                </a>
              </div>
            </div></ScrollReveal>
            <ScrollReveal direction="right" delay={0.15}>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 font-mono text-[13px] leading-relaxed">
              <div className="flex items-center gap-2 text-zinc-500 mb-4">
                <div className="h-3 w-3 rounded-full bg-red-500/60" />
                <div className="h-3 w-3 rounded-full bg-yellow-500/60" />
                <div className="h-3 w-3 rounded-full bg-green-500/60" />
                <span className="ml-2 text-xs">terminal</span>
              </div>
              <div className="space-y-1.5">
                <p><span className="text-zinc-500">$</span> <span className="text-blue-400">pip install</span> data-label-factory</p>
                <p className="text-zinc-600"># set your OpenRouter key</p>
                <p><span className="text-zinc-500">$</span> <span className="text-blue-400">export</span> OPENROUTER_API_KEY=sk-or-...</p>
                <p className="text-zinc-600"># run the full pipeline</p>
                <p><span className="text-zinc-500">$</span> <span className="text-blue-400">data_label_factory pipeline</span> \</p>
                <p className="text-zinc-400 pl-4">--project stop-signs.yaml \</p>
                <p className="text-zinc-400 pl-4">--backend openrouter</p>
                <p className="mt-3 text-emerald-400">{">"} best.pt ready in experiments/latest/</p>
              </div>
            </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* Powered by */}
      <section className="border-t border-zinc-800/50 py-16">
        <ScrollReveal>
        <div className="mx-auto max-w-4xl px-6 text-center">
          <p className="text-xs uppercase tracking-widest text-zinc-500 mb-8">Powered by</p>
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-zinc-500">
            {["Gemma 4", "Falcon Perception", "OpenRouter", "YOLO11", "MLX", "RunPod"].map((name) => (
              <span key={name} className="text-sm font-medium">{name}</span>
            ))}
          </div>
        </div>
        </ScrollReveal>
      </section>

      {/* Final CTA */}
      <section className="border-t border-zinc-800/50 py-16">
        <ScrollReveal>
        <div className="mx-auto max-w-2xl px-6 text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Give your agent eyes.
          </h2>
          <p className="mt-4 text-zinc-400">
            From text description to trained vision model. No labeling, no
            training infrastructure, no PhD required.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <Link
              href="/build"
              className="inline-flex h-12 items-center gap-2 rounded-xl bg-blue-600 px-8 text-base font-semibold text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-500 active:scale-[0.98]"
            >
              Start Building
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </Link>
            <a
              href="https://github.com/walter-grace/data-label-factory"
              target="_blank"
              className="inline-flex h-12 items-center gap-2 rounded-xl border border-zinc-700 px-8 text-base font-medium text-zinc-300 transition hover:bg-zinc-800"
            >
              View Source
            </a>
          </div>
        </div>
        </ScrollReveal>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800/50 py-8">
        <div className="mx-auto max-w-5xl px-6 flex flex-col items-center justify-between gap-4 text-sm text-zinc-500 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-[8px] font-black text-white">
              DLF
            </div>
            <span>Data Label Factory</span>
          </div>
          <div className="flex gap-6">
            <Link href="/build" className="transition hover:text-zinc-300">Build</Link>
            <Link href="/train" className="transition hover:text-zinc-300">Train</Link>
            <Link href="/pipeline" className="transition hover:text-zinc-300">Research</Link>
            <Link href="/label" className="transition hover:text-zinc-300">Label</Link>
            <a href="https://github.com/walter-grace/data-label-factory" target="_blank" className="transition hover:text-zinc-300">GitHub</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
