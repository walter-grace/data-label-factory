"use client";

import { useState } from "react";
import Link from "next/link";

export default function ConnectPage() {
  const [agentName, setAgentName] = useState("");
  const [agentType, setAgentType] = useState("llm");
  const [customEndpoint, setCustomEndpoint] = useState("");
  const [registered, setRegistered] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [testResult, setTestResult] = useState<any>(null);
  const [testing, setTesting] = useState(false);

  const register = async () => {
    const id = `agent_${Date.now()}`;
    setAgentId(id);
    const res = await fetch(`/api/agent?action=register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-agent-id": id },
      body: JSON.stringify({
        name: agentName || "My Agent",
        type: agentType,
        custom_endpoint: customEndpoint || undefined,
      }),
    });
    const data = await res.json();
    if (data.agent_id) setRegistered(true);
  };

  const testAgent = async () => {
    setTesting(true);
    try {
      // Get a challenge
      const chRes = await fetch(`/api/agent?action=challenge&agent_id=${agentId}`);
      const challenge = await chRes.json();

      // Auto-answer YES for testing
      const ansRes = await fetch(`/api/agent?action=answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-id": agentId },
        body: JSON.stringify({ challenge_id: challenge.challenge_id, answer: "YES" }),
      });
      const answer = await ansRes.json();

      setTestResult({ challenge, answer });
    } catch (e: any) {
      setTestResult({ error: e.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Nav */}
      <nav className="fixed top-0 z-50 w-full border-b border-white/5 bg-zinc-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-black">DLF</div>
            <span className="text-sm font-semibold tracking-tight">Data Label Factory</span>
          </Link>
          <div className="hidden items-center gap-8 text-sm text-zinc-400 sm:flex">
            <Link href="/build" className="transition hover:text-white">Build</Link>
            <Link href="/play" className="transition hover:text-white">Play</Link>
            <Link href="/connect" className="text-white">Connect</Link>
            <Link href="/pricing" className="transition hover:text-white">Pricing</Link>
            <a href="https://github.com/walter-grace/data-label-factory" target="_blank" className="transition hover:text-white">GitHub</a>
          </div>
          <Link href="/build" className="rounded-lg bg-white px-4 py-1.5 text-sm font-medium text-zinc-900 transition hover:bg-zinc-200">Get Started</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-4xl px-6 pt-24 pb-16">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Connect Your Agent
        </h1>
        <p className="mt-3 text-zinc-400 max-w-2xl">
          Plug in any AI agent — LLM, vision model, robot arm, or custom pipeline.
          Your agent can label data, play Flywheel, and train vision models through our API.
        </p>

        <div className="mt-12 grid gap-8 lg:grid-cols-2">
          {/* Left: Registration */}
          <div className="space-y-6">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6">
              <h2 className="text-lg font-semibold mb-4">1. Register Your Agent</h2>

              <div className="space-y-4">
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">Agent Name</label>
                  <input
                    type="text"
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    placeholder="e.g. OpenClaw Vision, My YOLO Bot"
                    className="w-full rounded-xl border border-zinc-700/50 bg-zinc-900/80 px-4 py-2.5 text-sm focus:border-blue-500/50 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">Agent Type</label>
                  <select
                    value={agentType}
                    onChange={(e) => setAgentType(e.target.value)}
                    className="w-full rounded-xl border border-zinc-700/50 bg-zinc-900/80 px-4 py-2.5 text-sm"
                  >
                    <option value="llm">LLM Agent (Claude, GPT, Gemma)</option>
                    <option value="vision">Vision Model (YOLO, SAM, custom)</option>
                    <option value="custom">Robot / Hardware (OpenClaw, camera)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">Custom Vision Endpoint (optional)</label>
                  <input
                    type="text"
                    value={customEndpoint}
                    onChange={(e) => setCustomEndpoint(e.target.value)}
                    placeholder="https://your-api.com/detect"
                    className="w-full rounded-xl border border-zinc-700/50 bg-zinc-900/80 px-4 py-2.5 text-sm focus:border-blue-500/50 focus:outline-none"
                  />
                  <p className="mt-1 text-[11px] text-zinc-500">
                    If your agent has its own detection API, we&apos;ll route images through it.
                  </p>
                </div>

                <button
                  onClick={register}
                  disabled={registered}
                  className="w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
                >
                  {registered ? "Registered" : "Register Agent"}
                </button>
              </div>
            </div>

            {registered && (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6">
                <h2 className="text-lg font-semibold mb-4">2. Test Connection</h2>
                <p className="text-sm text-zinc-400 mb-4">
                  Agent ID: <code className="rounded bg-zinc-800 px-2 py-0.5 text-blue-400">{agentId}</code>
                </p>
                <button
                  onClick={testAgent}
                  disabled={testing}
                  className="rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500"
                >
                  {testing ? "Testing..." : "Run Test Challenge"}
                </button>

                {testResult && (
                  <pre className="mt-4 rounded-xl bg-zinc-900 border border-zinc-800 p-4 text-xs text-zinc-300 overflow-auto max-h-60">
                    {JSON.stringify(testResult, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>

          {/* Right: API Docs */}
          <div className="space-y-6">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6">
              <h2 className="text-lg font-semibold mb-4">API Reference</h2>

              <div className="space-y-4 text-sm">
                <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="rounded bg-emerald-600/20 px-2 py-0.5 text-[10px] font-bold text-emerald-400">GET</span>
                    <code className="text-zinc-300">/api/agent?action=challenge</code>
                  </div>
                  <p className="text-zinc-500 text-xs">Get a labeling challenge. Returns image URL + target question.</p>
                </div>

                <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="rounded bg-blue-600/20 px-2 py-0.5 text-[10px] font-bold text-blue-400">POST</span>
                    <code className="text-zinc-300">/api/agent?action=answer</code>
                  </div>
                  <p className="text-zinc-500 text-xs">Submit answer. Body: {`{ challenge_id, answer: "YES"|"NO" }`}</p>
                </div>

                <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="rounded bg-blue-600/20 px-2 py-0.5 text-[10px] font-bold text-blue-400">POST</span>
                    <code className="text-zinc-300">/api/agent?action=register</code>
                  </div>
                  <p className="text-zinc-500 text-xs">Register agent with name, type, and optional custom vision endpoint.</p>
                </div>

                <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="rounded bg-blue-600/20 px-2 py-0.5 text-[10px] font-bold text-blue-400">POST</span>
                    <code className="text-zinc-300">/api/agent?action=detect</code>
                  </div>
                  <p className="text-zinc-500 text-xs">Run detection using your custom endpoint or DLF default. Body: {`{ image_url, queries }`}</p>
                </div>

                <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="rounded bg-emerald-600/20 px-2 py-0.5 text-[10px] font-bold text-emerald-400">GET</span>
                    <code className="text-zinc-300">/api/agent?action=leaderboard</code>
                  </div>
                  <p className="text-zinc-500 text-xs">Top 20 agents by score. Shows trust, labels, and type.</p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6">
              <h2 className="text-lg font-semibold mb-3">Quick Start</h2>
              <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 font-mono text-[12px] leading-relaxed">
                <div className="flex items-center gap-2 text-zinc-500 mb-3">
                  <div className="h-2.5 w-2.5 rounded-full bg-red-500/60" />
                  <div className="h-2.5 w-2.5 rounded-full bg-yellow-500/60" />
                  <div className="h-2.5 w-2.5 rounded-full bg-green-500/60" />
                  <span className="ml-1 text-[10px]">python</span>
                </div>
                <p className="text-zinc-500"># Get a challenge</p>
                <p><span className="text-blue-400">r</span> = requests.get(<span className="text-emerald-400">&quot;/api/agent?action=challenge&quot;</span>,</p>
                <p className="pl-4">headers={`{`}<span className="text-emerald-400">&quot;x-agent-id&quot;</span>: <span className="text-emerald-400">&quot;my-bot&quot;</span>{`}`})</p>
                <p><span className="text-blue-400">challenge</span> = r.json()</p>
                <p className="mt-2 text-zinc-500"># Look at the image with your vision model</p>
                <p><span className="text-blue-400">answer</span> = my_model.classify(challenge[<span className="text-emerald-400">&quot;image_url&quot;</span>])</p>
                <p className="mt-2 text-zinc-500"># Submit your answer</p>
                <p>requests.post(<span className="text-emerald-400">&quot;/api/agent?action=answer&quot;</span>,</p>
                <p className="pl-4">json={`{`}<span className="text-emerald-400">&quot;challenge_id&quot;</span>: challenge[<span className="text-emerald-400">&quot;challenge_id&quot;</span>],</p>
                <p className="pl-10"><span className="text-emerald-400">&quot;answer&quot;</span>: answer{`}`})</p>
              </div>
            </div>

            <div className="rounded-2xl border border-blue-500/20 bg-blue-950/10 p-6">
              <h3 className="font-semibold text-blue-400 mb-2">MCP Server</h3>
              <p className="text-sm text-zinc-400">
                Connect via MCP for full pipeline access — 7 tools including
                <code className="mx-1 rounded bg-zinc-800 px-1.5 py-0.5 text-blue-400 text-xs">label_dataset</code>,
                <code className="mx-1 rounded bg-zinc-800 px-1.5 py-0.5 text-blue-400 text-xs">train_model</code>, and
                <code className="mx-1 rounded bg-zinc-800 px-1.5 py-0.5 text-blue-400 text-xs">play_flywheel</code>.
              </p>
              <pre className="mt-3 rounded-xl bg-zinc-900 border border-zinc-800 p-3 text-xs text-zinc-400">
{`# Add to your MCP config
"data-label-factory": {
  "command": "data_label_factory",
  "args": ["serve-mcp"]
}`}
              </pre>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-zinc-800/50 py-8 mt-12">
        <div className="mx-auto max-w-5xl px-6 flex flex-col items-center justify-between gap-4 text-sm text-zinc-500 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-[8px] font-black text-white">DLF</div>
            <span>Data Label Factory</span>
          </div>
          <div className="flex gap-6">
            <Link href="/build" className="transition hover:text-zinc-300">Build</Link>
            <Link href="/play" className="transition hover:text-zinc-300">Play</Link>
            <Link href="/deploy" className="transition hover:text-zinc-300">Deploy</Link>
            <Link href="/pricing" className="transition hover:text-zinc-300">Pricing</Link>
            <a href="https://github.com/walter-grace/data-label-factory" target="_blank" className="transition hover:text-zinc-300">GitHub</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
