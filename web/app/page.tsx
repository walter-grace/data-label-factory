"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export default function Home() {
  const [providers, setProviders] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/dlf?path=/api/providers")
      .then((r) => r.json())
      .then((d) => setProviders(d.providers ?? []))
      .catch(() => {});
  }, []);

  const alive = providers.filter((p) => p.alive);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-blue-950/30 via-zinc-950 to-zinc-950" />
        <div className="relative mx-auto max-w-4xl px-6 py-24 text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-1.5 text-sm text-zinc-300">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            {alive.length > 0
              ? `${alive.length} AI backends online`
              : "Connecting..."}
          </div>

          <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">
            Tell us what to detect.
            <br />
            <span className="bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
              We build the model.
            </span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400">
            Upload images or describe what you need — our AI pipeline gathers
            data, labels bounding boxes, verifies quality, and exports a
            ready-to-train YOLO dataset. From idea to custom vision model in
            minutes.
          </p>

          <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <Link
              href="/build"
              className="inline-flex h-12 items-center gap-2 rounded-lg bg-blue-600 px-8 text-base font-semibold text-white shadow-lg shadow-blue-600/25 transition hover:bg-blue-500"
            >
              Build a Dataset
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </Link>
            <Link
              href="/label"
              className="inline-flex h-12 items-center gap-2 rounded-lg border border-zinc-700 px-8 text-base font-medium text-zinc-300 transition hover:bg-zinc-800"
            >
              Label Images
            </Link>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-zinc-800 py-20">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="text-center text-3xl font-bold tracking-tight">
            How it works
          </h2>
          <p className="mt-3 text-center text-zinc-400">
            Five stages, fully automated. You just say what you need.
          </p>

          <div className="mt-14 grid gap-6 sm:grid-cols-5">
            {[
              { icon: "1", title: "Describe", desc: "Type what you want to detect or upload sample images" },
              { icon: "2", title: "Gather", desc: "We search the web for matching images automatically" },
              { icon: "3", title: "Filter", desc: "AI vision model checks each image — is this your target?" },
              { icon: "4", title: "Label", desc: "Falcon Perception draws precise bounding boxes" },
              { icon: "5", title: "Export", desc: "YOLO dataset ready to train — download and go" },
            ].map((step, i) => (
              <div key={i} className="relative text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-blue-600/20 text-blue-400 text-lg font-bold">
                  {step.icon}
                </div>
                {i < 4 && (
                  <div className="absolute top-6 left-[calc(50%+28px)] hidden h-px w-[calc(100%-56px)] bg-zinc-700 sm:block" />
                )}
                <h3 className="mt-4 font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm text-zinc-400">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Input methods */}
      <section className="border-t border-zinc-800 py-20">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="text-center text-3xl font-bold tracking-tight">
            Three ways to get started
          </h2>

          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            {[
              {
                title: "Upload Images",
                desc: "Drag and drop your own images. We label them with bounding boxes and export a YOLO dataset.",
                icon: (
                  <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                  </svg>
                ),
              },
              {
                title: "Paste a URL",
                desc: "Roboflow dataset, GitHub repo, or any image URL. We pull the images and run the pipeline.",
                icon: (
                  <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.07-9.07a4.5 4.5 0 00-1.242-7.244l-4.5 4.5a4.5 4.5 0 006.364 6.364l1.757-1.757" />
                  </svg>
                ),
              },
              {
                title: "Auto-Gather",
                desc: "Just describe what you want. We search the internet, download images, and build the dataset for you.",
                icon: (
                  <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                  </svg>
                ),
              },
            ].map((method, i) => (
              <div
                key={i}
                className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 transition hover:border-zinc-700 hover:bg-zinc-900"
              >
                <div className="text-blue-400">{method.icon}</div>
                <h3 className="mt-4 text-lg font-semibold">{method.title}</h3>
                <p className="mt-2 text-sm text-zinc-400">{method.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Backends */}
      {providers.length > 0 && (
        <section className="border-t border-zinc-800 py-20">
          <div className="mx-auto max-w-4xl px-6">
            <h2 className="text-center text-3xl font-bold tracking-tight">
              Powered by {alive.length} AI backends
            </h2>
            <p className="mt-3 text-center text-zinc-400">
              Mix and match vision models for every stage of the pipeline
            </p>

            <div className="mt-10 grid gap-3 sm:grid-cols-2">
              {providers.map((p) => (
                <div
                  key={p.name}
                  className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        p.alive ? "bg-emerald-400" : "bg-zinc-600"
                      }`}
                    />
                    <span className="font-mono text-sm font-medium">
                      {p.name}
                    </span>
                  </div>
                  <div className="flex gap-1.5">
                    {(p.capabilities ?? []).map((c: string) => (
                      <span
                        key={c}
                        className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* CTA */}
      <section className="border-t border-zinc-800 py-20">
        <div className="mx-auto max-w-2xl px-6 text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            Ready to build?
          </h2>
          <p className="mt-3 text-zinc-400">
            No account needed. Upload images, describe your target, and get a
            YOLO dataset in minutes.
          </p>
          <Link
            href="/build"
            className="mt-8 inline-flex h-12 items-center gap-2 rounded-lg bg-blue-600 px-8 text-base font-semibold text-white shadow-lg shadow-blue-600/25 transition hover:bg-blue-500"
          >
            Start Building
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800 py-8">
        <div className="mx-auto max-w-5xl px-6 flex items-center justify-between text-sm text-zinc-500">
          <span>data-label-factory v0.2.0</span>
          <div className="flex gap-6">
            <Link href="/build" className="hover:text-zinc-300">Build</Link>
            <Link href="/train" className="hover:text-zinc-300">Train</Link>
            <Link href="/label" className="hover:text-zinc-300">Label</Link>
            <Link href="/canvas" className="hover:text-zinc-300">Canvas</Link>
            <a href="https://github.com/walter-grace/data-label-factory" target="_blank" className="hover:text-zinc-300">GitHub</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
