"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";

/**
 * /play/docs — Document-layout Flywheel game.
 *
 * Humans see a cropped page region + tentative type, decide whether the
 * block is (e.g.) a section header. Agents use the same backend via MCP
 * (`play_flywheel_docs` tool) or direct HTTP (`/api/agent?action=doc-challenge`).
 *
 * Trust + reward piping mirrors image-mode /play — honeypot answers feed
 * the agent's trust score; real-challenge labels go to /api/rewards with
 * source_type="doc" for eventual GRPO training of a doc-layout model.
 */

type DocChallenge = {
  challenge_id: string;
  doc_id: string;
  block_text: string;
  bbox: [number, number, number, number];
  page_width: number;
  page_height: number;
  page_image_url: string;
  question: string;
  question_field: string;
  tentative_type: string;
};

type AnswerResult = {
  challenge_kind: "image" | "doc";
  correct: boolean;
  was_honeypot: boolean;
  trust_score: number;
  score: number;
  label_accepted: boolean;
  total_labels: number;
};

const AGENT_ID = typeof window !== "undefined" ? "human-" + Math.random().toString(36).slice(2, 8) : "human";
const RENDER_DPI = 150; // must match lit's render DPI
const PDF_DPI = 72;     // points → pixels scale
const SCALE = RENDER_DPI / PDF_DPI;

export default function PlayDocsPage() {
  const [challenge, setChallenge] = useState<DocChallenge | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastAnswer, setLastAnswer] = useState<{ answer: "YES" | "NO"; result: AnswerResult } | null>(null);
  const [trust, setTrust] = useState(100);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [history, setHistory] = useState<Array<{ block: string; answer: "YES" | "NO"; correct: boolean | null; honeypot: boolean }>>([]);
  const [challengeStart, setChallengeStart] = useState(0);

  const startTime = useRef(Date.now());

  const fetchChallenge = useCallback(async () => {
    setLoading(true);
    setLastAnswer(null);
    try {
      const r = await fetch(`/api/agent?action=doc-challenge&agent_id=${AGENT_ID}`, {
        cache: "no-store",
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "fetch failed");
      setChallenge(data);
      setChallengeStart(Date.now());
    } catch (e: any) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChallenge();
  }, [fetchChallenge]);

  const submit = async (answer: "YES" | "NO") => {
    if (!challenge || loading || lastAnswer) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/agent?action=doc-answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-id": AGENT_ID },
        body: JSON.stringify({ challenge_id: challenge.challenge_id, answer }),
      });
      const result: AnswerResult = await r.json();
      setLastAnswer({ answer, result });
      setTrust(result.trust_score);
      setScore(result.score);
      setHistory((h) => [
        {
          block: challenge.block_text,
          answer,
          correct: result.was_honeypot ? result.correct : null,
          honeypot: result.was_honeypot,
        },
        ...h,
      ].slice(0, 10));
      // Streak counts only honeypot-confirmed correct answers
      if (result.was_honeypot && result.correct) {
        setStreak((s) => s + 1);
      } else if (result.was_honeypot && !result.correct) {
        setStreak(0);
      }
    } catch (e: any) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // Compute crop window positioning for the rendered page image.
  // lit rendered at 150 DPI; PDF coords are in points (72 DPI).
  const crop = challenge
    ? {
        x: challenge.bbox[0] * SCALE,
        y: challenge.bbox[1] * SCALE,
        w: Math.max((challenge.bbox[2] - challenge.bbox[0]) * SCALE, 40),
        h: Math.max((challenge.bbox[3] - challenge.bbox[1]) * SCALE, 20),
        pageW: challenge.page_width * SCALE,
        pageH: challenge.page_height * SCALE,
      }
    : null;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Nav */}
      <nav className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-bold tracking-tight">
            Data Label Factory
          </Link>
          <div className="flex gap-6 text-sm text-zinc-400">
            <Link href="/play" className="hover:text-white">Images</Link>
            <Link href="/play/docs" className="text-white">Documents</Link>
            <Link href="/arena" className="hover:text-white">Arena</Link>
            <Link href="/connect" className="hover:text-white">Connect</Link>
          </div>
        </div>
      </nav>

      {/* Header strip with stats */}
      <div className="border-b border-zinc-800/50">
        <div className="mx-auto max-w-5xl px-6 py-4 flex items-center justify-between text-sm">
          <div>
            <h1 className="text-xl font-bold">Document Flywheel</h1>
            <p className="text-zinc-500 text-xs mt-0.5">
              Verify block labels. Honeypots keep agents honest. Labels feed GRPO training.
            </p>
          </div>
          <div className="flex gap-6">
            <Stat label="trust" value={String(trust)} warn={trust < 50} />
            <Stat label="score" value={String(score)} />
            <Stat label="streak" value={String(streak)} />
            <Stat label="labels" value={String(history.length)} />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-6 py-8">
        {loading && !challenge && (
          <div className="text-center text-zinc-500 py-20">Loading challenge…</div>
        )}

        {challenge && crop && (
          <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
            {/* Block crop */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500">Document</div>
                  <div className="text-sm text-zinc-200">{challenge.doc_id.replace(/_/g, " ")}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500">Tentative</div>
                  <div className="text-sm text-zinc-400">{challenge.tentative_type}</div>
                </div>
              </div>

              <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
                The block
              </div>
              {/* Block text — text-only LLMs answer off this alone */}
              <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-5 mb-6">
                <p className="text-base leading-relaxed text-zinc-100">
                  {challenge.block_text}
                </p>
              </div>

              {/* Visual crop of the page (for the vision-inclined) */}
              <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
                Crop from page
              </div>
              <div
                className="relative overflow-hidden rounded-xl border border-zinc-800 bg-white"
                style={{
                  width: Math.min(560, crop.w + 40),
                  height: Math.min(200, crop.h + 40),
                }}
              >
                <img
                  src={challenge.page_image_url}
                  alt=""
                  style={{
                    position: "absolute",
                    left: -(crop.x - 20),
                    top: -(crop.y - 20),
                    width: crop.pageW,
                    maxWidth: "none",
                  }}
                />
                {/* Bbox outline */}
                <div
                  className="absolute border-2 border-blue-500 rounded-sm pointer-events-none"
                  style={{
                    left: 20,
                    top: 20,
                    width: crop.w,
                    height: crop.h,
                  }}
                />
              </div>

              <div className="mt-6 text-center">
                <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Question</div>
                <div className="text-lg font-semibold mb-5">{challenge.question}</div>

                <div className="flex gap-3 justify-center">
                  <button
                    onClick={() => submit("NO")}
                    disabled={loading || !!lastAnswer}
                    className="rounded-xl bg-red-600/20 border border-red-500/40 hover:bg-red-600/30 px-8 py-3 font-bold text-red-300 disabled:opacity-40"
                  >
                    NO
                  </button>
                  <button
                    onClick={() => submit("YES")}
                    disabled={loading || !!lastAnswer}
                    className="rounded-xl bg-emerald-600/20 border border-emerald-500/40 hover:bg-emerald-600/30 px-8 py-3 font-bold text-emerald-300 disabled:opacity-40"
                  >
                    YES
                  </button>
                </div>
              </div>

              {/* Feedback */}
              {lastAnswer && (
                <div
                  className={`mt-6 rounded-xl border p-4 ${
                    lastAnswer.result.was_honeypot
                      ? lastAnswer.result.correct
                        ? "border-emerald-500/40 bg-emerald-600/10 text-emerald-200"
                        : "border-red-500/40 bg-red-600/10 text-red-200"
                      : "border-blue-500/40 bg-blue-600/10 text-blue-200"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      {lastAnswer.result.was_honeypot ? (
                        lastAnswer.result.correct ? (
                          <>
                            <div className="font-bold">✓ Correct honeypot!</div>
                            <div className="text-xs opacity-80">+5 trust, +10 score</div>
                          </>
                        ) : (
                          <>
                            <div className="font-bold">✗ Missed honeypot</div>
                            <div className="text-xs opacity-80">-25 trust</div>
                          </>
                        )
                      ) : (
                        <>
                          <div className="font-bold">
                            {lastAnswer.result.label_accepted
                              ? "Label accepted → training data"
                              : "Label held (trust too low)"}
                          </div>
                          <div className="text-xs opacity-80">
                            Your answer: {lastAnswer.answer} — +{lastAnswer.result.correct ? 10 : 0} score
                          </div>
                        </>
                      )}
                    </div>
                    <button
                      onClick={fetchChallenge}
                      className="rounded-lg bg-zinc-900 border border-zinc-700 hover:border-zinc-500 px-4 py-2 text-sm font-medium"
                    >
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Right column — history + agent playbook */}
            <div className="space-y-4">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
                <div className="text-xs uppercase tracking-wider text-zinc-500 mb-3">Recent</div>
                <div className="space-y-2">
                  {history.length === 0 ? (
                    <div className="text-xs text-zinc-600">No answers yet</div>
                  ) : (
                    history.map((h, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span
                          className={`font-bold w-8 ${
                            h.correct === true
                              ? "text-emerald-400"
                              : h.correct === false
                                ? "text-red-400"
                                : "text-zinc-500"
                          }`}
                        >
                          {h.answer}
                        </span>
                        <span className="text-zinc-600 truncate">
                          {h.honeypot ? "🎯" : "  "}{" "}{h.block.slice(0, 38)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
                <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">For agents</div>
                <div className="text-xs text-zinc-400 space-y-2">
                  <p>Same game is available via MCP:</p>
                  <pre className="text-[11px] bg-zinc-950 border border-zinc-800 rounded p-2 overflow-x-auto">
{`play_flywheel_docs(
  action="challenge"
)
# → block_text, bbox, page_image_url

play_flywheel_docs(
  action="answer",
  challenge_id=...,
  answer="YES"
)`}
                  </pre>
                  <p className="text-[11px] text-zinc-600">
                    Text-only LLMs answer off block_text. Vision models crop the bbox from page_image_url.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`font-mono text-sm ${warn ? "text-red-400" : "text-zinc-200"}`}>
        {value}
      </div>
    </div>
  );
}
