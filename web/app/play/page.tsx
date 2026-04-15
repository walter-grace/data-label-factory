"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type GameMode = "menu" | "filter" | "bbox" | "results";

type Challenge = {
  id: number;
  imageUrl: string;
  target: string;
  aiPrediction: "YES" | "NO";
  aiConfidence: number;
  aiBbox?: { x: number; y: number; w: number; h: number };
  isHoneypot: boolean;        // true = we KNOW the ground truth
  groundTruth?: "YES" | "NO"; // only set for honeypots
};

type Answer = {
  challengeId: number;
  userAnswer: "YES" | "NO";
  correct: boolean;
  timeMs: number;
  wasHoneypot: boolean;
};

// Sample challenges. In production: real pipeline images from R2.
// Honeypots have KNOWN ground truth — used to measure player reliability.
// ~30% of challenges are honeypots (player never knows which ones).
const SAMPLE_CHALLENGES: Challenge[] = [
  // Honeypots — we KNOW the answer. Tests player trustworthiness.
  { id: 1, imageUrl: "https://images.unsplash.com/photo-1566933293069-b55c7f326dd4?w=400", target: "car", aiPrediction: "YES", aiConfidence: 0.92, isHoneypot: true, groundTruth: "YES" },
  { id: 2, imageUrl: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400", target: "car", aiPrediction: "NO", aiConfidence: 0.95, isHoneypot: true, groundTruth: "NO" },
  { id: 3, imageUrl: "https://images.unsplash.com/photo-1517849845537-4d257902454a?w=400", target: "dog", aiPrediction: "YES", aiConfidence: 0.96, isHoneypot: true, groundTruth: "YES" },
  // Real challenges — AI made a prediction, we need human verification
  { id: 4, imageUrl: "https://images.unsplash.com/photo-1518791841217-8f162f1e1131?w=400", target: "dog", aiPrediction: "YES", aiConfidence: 0.88, isHoneypot: false },
  { id: 5, imageUrl: "https://images.unsplash.com/photo-1543466835-00a7907e9de1?w=400", target: "dog", aiPrediction: "YES", aiConfidence: 0.78, isHoneypot: false },
  { id: 6, imageUrl: "https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=400", target: "stop sign", aiPrediction: "NO", aiConfidence: 0.85, isHoneypot: false },
  { id: 7, imageUrl: "https://images.unsplash.com/photo-1583337130417-13104dec14a4?w=400", target: "cat", aiPrediction: "YES", aiConfidence: 0.91, isHoneypot: false },
  { id: 8, imageUrl: "https://images.unsplash.com/photo-1474511320723-9a56873571b7?w=400", target: "bird", aiPrediction: "YES", aiConfidence: 0.73, isHoneypot: false },
  { id: 9, imageUrl: "https://images.unsplash.com/photo-1501594907352-04cda38ebc29?w=400", target: "fire hydrant", aiPrediction: "NO", aiConfidence: 0.89, isHoneypot: false },
  { id: 10, imageUrl: "https://images.unsplash.com/photo-1526336024174-e58f5cdd8e13?w=400", target: "cat", aiPrediction: "YES", aiConfidence: 0.84, isHoneypot: false },
];

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function PlayPage() {
  const [mode, setMode] = useState<GameMode>("menu");
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [timeLeft, setTimeLeft] = useState(60);
  const [roundStartTime, setRoundStartTime] = useState(0);
  const [challengeStartTime, setChallengeStartTime] = useState(0);
  const [showFeedback, setShowFeedback] = useState<"correct" | "wrong" | null>(null);
  const [trustScore, setTrustScore] = useState(100); // 0-100, based on honeypot accuracy
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Start a game round
  const startGame = useCallback((gameMode: "filter" | "bbox") => {
    const shuffled = [...SAMPLE_CHALLENGES].sort(() => Math.random() - 0.5);
    setChallenges(shuffled);
    setCurrentIdx(0);
    setAnswers([]);
    setScore(0);
    setStreak(0);
    setBestStreak(0);
    setTimeLeft(60);
    setTrustScore(100);
    setMode(gameMode);
    setRoundStartTime(Date.now());
    setChallengeStartTime(Date.now());
    setShowFeedback(null);
  }, []);

  // Timer countdown
  useEffect(() => {
    if (mode !== "filter" && mode !== "bbox") return;
    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          setMode("results");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [mode]);

  // Handle answer
  const handleAnswer = useCallback((userAnswer: "YES" | "NO") => {
    const challenge = challenges[currentIdx];
    if (!challenge) return;

    const timeMs = Date.now() - challengeStartTime;

    // Honeypots: check against KNOWN ground truth (measures player reliability)
    // Real challenges: check against AI prediction (player is verifying the AI)
    let correct: boolean;
    if (challenge.isHoneypot && challenge.groundTruth) {
      correct = userAnswer === challenge.groundTruth;
      // Update trust score based on honeypot performance
      setTrustScore((prev) => correct
        ? Math.min(100, prev + 5)   // reward correct honeypot
        : Math.max(0, prev - 25)    // heavily penalize wrong honeypot
      );
    } else {
      // Real challenge — agreement with AI counts as "correct" for scoring
      // but the real value is the label itself (stored for GRPO)
      correct = userAnswer === challenge.aiPrediction;
    }

    const newStreak = correct ? streak + 1 : 0;
    const pointsEarned = correct ? (10 + Math.min(newStreak * 5, 50) + Math.max(0, Math.floor((3000 - timeMs) / 100))) : 0;

    setAnswers((prev) => [...prev, { challengeId: challenge.id, userAnswer, correct, timeMs, wasHoneypot: challenge.isHoneypot }]);
    setScore((prev) => prev + pointsEarned);
    setStreak(newStreak);
    if (newStreak > bestStreak) setBestStreak(newStreak);

    // Show feedback briefly
    setShowFeedback(correct ? "correct" : "wrong");
    setTimeout(() => {
      setShowFeedback(null);
      if (currentIdx + 1 < challenges.length) {
        setCurrentIdx((prev) => prev + 1);
        setChallengeStartTime(Date.now());
      } else {
        // Ran out of challenges — cycle back
        const reshuffled = [...SAMPLE_CHALLENGES].sort(() => Math.random() - 0.5);
        setChallenges(reshuffled);
        setCurrentIdx(0);
        setChallengeStartTime(Date.now());
      }
    }, 400);
  }, [challenges, currentIdx, challengeStartTime, streak, bestStreak]);

  // Keyboard shortcuts
  useEffect(() => {
    if (mode !== "filter") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "y" || e.key === "ArrowRight") handleAnswer("YES");
      if (e.key === "n" || e.key === "ArrowLeft") handleAnswer("NO");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, handleAnswer]);

  const current = challenges[currentIdx];
  const accuracy = answers.length > 0 ? Math.round((answers.filter((a) => a.correct).length / answers.length) * 100) : 0;
  const avgTime = answers.length > 0 ? Math.round(answers.reduce((s, a) => s + a.timeMs, 0) / answers.length) : 0;
  const honeypotAnswers = answers.filter((a) => a.wasHoneypot);
  const honeypotAccuracy = honeypotAnswers.length > 0 ? Math.round((honeypotAnswers.filter((a) => a.correct).length / honeypotAnswers.length) * 100) : 100;
  const realAnswers = answers.filter((a) => !a.wasHoneypot);
  const labelsAccepted = trustScore >= 50 ? realAnswers.filter((a) => a.correct).length : 0;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Nav */}
      <nav className="fixed top-0 z-50 w-full border-b border-white/5 bg-zinc-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-black">DLF</div>
            <span className="text-sm font-semibold tracking-tight">Flywheel</span>
          </Link>
          <div className="hidden items-center gap-8 text-sm text-zinc-400 sm:flex">
            <Link href="/" className="transition hover:text-white">Home</Link>
            <Link href="/build" className="transition hover:text-white">Build</Link>
            <Link href="/play" className="text-white">Play</Link>
            <Link href="/pricing" className="transition hover:text-white">Pricing</Link>
          </div>
          {mode !== "menu" && (
            <div className="flex items-center gap-4 text-sm">
              <span className="font-mono text-blue-400">{score} pts</span>
              <span className="font-mono text-zinc-400">{timeLeft}s</span>
            </div>
          )}
        </div>
      </nav>

      <div className="pt-14">
        {/* ==================== MENU ==================== */}
        {mode === "menu" && (
          <div className="mx-auto max-w-3xl px-6 pt-20 pb-16 text-center">
            <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/80 px-4 py-1.5 text-[13px] text-zinc-400">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
              Help train AI vision models
            </div>

            <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">
              Play
              <span className="bg-gradient-to-r from-blue-400 via-blue-300 to-cyan-400 bg-clip-text text-transparent">
                {" "}Flywheel
              </span>
            </h1>

            <p className="mx-auto mt-5 max-w-xl text-lg text-zinc-400">
              Label images, earn points, climb the leaderboard.
              Every answer trains the AI to see better.
            </p>

            <div className="mt-12 grid gap-5 sm:grid-cols-2 max-w-lg mx-auto">
              {/* Quick Filter mode */}
              <button
                onClick={() => startGame("filter")}
                className="group rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6 text-left transition hover:border-blue-500/30 hover:bg-zinc-900/60"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600/10 text-2xl mb-4">
                  Y/N
                </div>
                <h3 className="text-lg font-semibold">Quick Filter</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  Is this a [target]? YES or NO. 60 seconds, as many as you can.
                </p>
                <div className="mt-3 text-xs text-blue-400 group-hover:text-blue-300">
                  Press Y or N to answer &rarr;
                </div>
              </button>

              {/* Bbox Judge mode */}
              <button
                onClick={() => startGame("bbox")}
                className="group rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6 text-left transition hover:border-blue-500/30 hover:bg-zinc-900/60"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600/10 text-2xl mb-4">
                  [ ]
                </div>
                <h3 className="text-lg font-semibold">Bbox Judge</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  Is this bounding box correct? Rate the AI&apos;s detection accuracy.
                </p>
                <div className="mt-3 text-xs text-blue-400 group-hover:text-blue-300">
                  Coming soon &rarr;
                </div>
              </button>
            </div>

            {/* How it works */}
            <div className="mt-16 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-8 max-w-lg mx-auto text-left">
              <h3 className="font-semibold mb-4">How Flywheel works</h3>
              <div className="space-y-3 text-sm text-zinc-400">
                <div className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600/20 text-blue-400 text-xs font-bold">1</span>
                  <span>You see an image and a question: &quot;Is this a [target]?&quot;</span>
                </div>
                <div className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600/20 text-blue-400 text-xs font-bold">2</span>
                  <span>Answer YES or NO as fast as you can. Faster = more points.</span>
                </div>
                <div className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600/20 text-blue-400 text-xs font-bold">3</span>
                  <span>Build streaks for bonus points. Compete on the leaderboard.</span>
                </div>
                <div className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600/20 text-blue-400 text-xs font-bold">4</span>
                  <span>Your answers train the AI — every label makes the model smarter.</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ==================== FILTER GAME ==================== */}
        {mode === "filter" && current && (
          <div className="mx-auto max-w-2xl px-6 pt-8">
            {/* Stats bar */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-6 text-sm">
                <div>
                  <span className="text-zinc-500">Score </span>
                  <span className="font-bold text-blue-400">{score}</span>
                </div>
                <div>
                  <span className="text-zinc-500">Streak </span>
                  <span className="font-bold text-cyan-400">{streak}</span>
                  {streak >= 3 && <span className="ml-1 text-xs text-cyan-400 animate-pulse">x{Math.min(streak, 10)}</span>}
                </div>
                <div>
                  <span className="text-zinc-500">Labeled </span>
                  <span className="font-bold">{answers.length}</span>
                </div>
                <div>
                  <span className="text-zinc-500">Trust </span>
                  <span className={`font-bold ${trustScore >= 75 ? "text-emerald-400" : trustScore >= 50 ? "text-yellow-400" : "text-red-400"}`}>{trustScore}%</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className={`text-2xl font-mono font-bold ${timeLeft <= 10 ? "text-red-400 animate-pulse" : "text-zinc-300"}`}>
                  {timeLeft}s
                </div>
              </div>
            </div>

            {/* Timer bar */}
            <div className="h-1 w-full rounded-full bg-zinc-800 mb-6 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ${timeLeft <= 10 ? "bg-red-500" : "bg-blue-500"}`}
                style={{ width: `${(timeLeft / 60) * 100}%` }}
              />
            </div>

            {/* Question */}
            <div className="text-center mb-4">
              <span className="text-zinc-400">Is this a </span>
              <span className="text-xl font-bold text-white">{current.target}</span>
              <span className="text-zinc-400">?</span>
            </div>

            {/* Image */}
            <div className="relative rounded-2xl overflow-hidden border border-zinc-800 bg-zinc-900/50 aspect-[4/3]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={current.imageUrl}
                alt=""
                className="w-full h-full object-cover"
              />

              {/* Feedback overlay */}
              {showFeedback && (
                <div className={`absolute inset-0 flex items-center justify-center ${
                  showFeedback === "correct" ? "bg-emerald-500/20" : "bg-red-500/20"
                }`}>
                  <div className={`text-6xl font-black ${
                    showFeedback === "correct" ? "text-emerald-400" : "text-red-400"
                  }`}>
                    {showFeedback === "correct" ? "+" : "X"}
                  </div>
                </div>
              )}

              {/* AI confidence badge */}
              <div className="absolute top-3 right-3 rounded-full bg-black/60 px-3 py-1 text-[11px] text-zinc-400 backdrop-blur-sm">
                AI: {Math.round(current.aiConfidence * 100)}% confident
              </div>
            </div>

            {/* Answer buttons */}
            <div className="mt-6 grid grid-cols-2 gap-4">
              <button
                onClick={() => handleAnswer("NO")}
                className="h-16 rounded-2xl border border-zinc-700 bg-zinc-900/50 text-xl font-bold text-zinc-300 transition hover:border-red-500/50 hover:bg-red-950/20 hover:text-red-400 active:scale-[0.98]"
              >
                NO
                <span className="block text-[10px] font-normal text-zinc-500 mt-0.5">
                  press N or &larr;
                </span>
              </button>
              <button
                onClick={() => handleAnswer("YES")}
                className="h-16 rounded-2xl border border-zinc-700 bg-zinc-900/50 text-xl font-bold text-zinc-300 transition hover:border-emerald-500/50 hover:bg-emerald-950/20 hover:text-emerald-400 active:scale-[0.98]"
              >
                YES
                <span className="block text-[10px] font-normal text-zinc-500 mt-0.5">
                  press Y or &rarr;
                </span>
              </button>
            </div>
          </div>
        )}

        {/* ==================== RESULTS ==================== */}
        {mode === "results" && (
          <div className="mx-auto max-w-lg px-6 pt-16 text-center">
            <h2 className="text-4xl font-bold tracking-tight">
              {score >= 500 ? "Amazing!" : score >= 200 ? "Nice work!" : "Good try!"}
            </h2>
            <p className="mt-2 text-zinc-400">
              You labeled {answers.length} images and helped train the AI.
            </p>

            {/* Score display */}
            <div className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-8">
              <div className="text-6xl font-black text-blue-400">{score}</div>
              <div className="text-sm text-zinc-500 mt-1">points</div>

              <div className="mt-6 grid grid-cols-3 gap-4">
                <div>
                  <div className="text-2xl font-bold">{answers.length}</div>
                  <div className="text-xs text-zinc-500">Labeled</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-emerald-400">{accuracy}%</div>
                  <div className="text-xs text-zinc-500">Accuracy</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-cyan-400">{bestStreak}</div>
                  <div className="text-xs text-zinc-500">Best Streak</div>
                </div>
              </div>

              <div className="mt-4 text-xs text-zinc-500">
                Avg response: {avgTime}ms
              </div>
            </div>

            {/* Trust score + GRPO contribution */}
            <div className={`mt-6 rounded-2xl border p-4 text-sm ${
              trustScore >= 75 ? "border-emerald-500/20 bg-emerald-950/10" :
              trustScore >= 50 ? "border-blue-500/20 bg-blue-950/10" :
              "border-red-500/20 bg-red-950/10"
            }`}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-zinc-300">Trust Score</span>
                <span className={`font-bold ${
                  trustScore >= 75 ? "text-emerald-400" : trustScore >= 50 ? "text-blue-400" : "text-red-400"
                }`}>
                  {trustScore}%
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden mb-3">
                <div className={`h-full rounded-full transition-all ${
                  trustScore >= 75 ? "bg-emerald-500" : trustScore >= 50 ? "bg-blue-500" : "bg-red-500"
                }`} style={{ width: `${trustScore}%` }} />
              </div>
              {trustScore >= 50 ? (
                <p className="text-zinc-400">
                  <span className="text-blue-400 font-semibold">{labelsAccepted} verified labels</span>
                  {" "}accepted for GRPO training. Your honeypot accuracy: {honeypotAccuracy}%.
                  {honeypotAnswers.length > 0 && ` (${honeypotAnswers.filter(a => a.correct).length}/${honeypotAnswers.length} correct)`}
                </p>
              ) : (
                <p className="text-red-400">
                  Trust too low — labels discarded. You missed too many verification checks.
                  Play again more carefully to contribute to training.
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="mt-8 flex gap-3 justify-center">
              <button
                onClick={() => startGame("filter")}
                className="rounded-xl bg-blue-600 px-8 py-3 text-base font-semibold text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-500 active:scale-[0.98]"
              >
                Play Again
              </button>
              <button
                onClick={() => setMode("menu")}
                className="rounded-xl border border-zinc-700 px-8 py-3 text-base font-medium text-zinc-300 transition hover:bg-zinc-800"
              >
                Menu
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t border-zinc-800/50 py-8 mt-16">
        <div className="mx-auto max-w-5xl px-6 flex flex-col items-center justify-between gap-4 text-sm text-zinc-500 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-[8px] font-black text-white">DLF</div>
            <span>Data Label Factory</span>
          </div>
          <div className="flex gap-6">
            <Link href="/" className="transition hover:text-zinc-300">Home</Link>
            <Link href="/build" className="transition hover:text-zinc-300">Build</Link>
            <Link href="/pricing" className="transition hover:text-zinc-300">Pricing</Link>
            <a href="https://github.com/walter-grace/data-label-factory" target="_blank" className="transition hover:text-zinc-300">GitHub</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
