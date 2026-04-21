"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";

import SiteNav from "@/components/SiteNav";
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
  isHoneypot: boolean;
  groundTruth?: "YES" | "NO";
};

type Answer = {
  challengeId: number;
  userAnswer: "YES" | "NO";
  correct: boolean;
  timeMs: number;
  wasHoneypot: boolean;
};

type FloatingPoint = {
  id: number;
  value: string;
  x: number;
  y: number;
  color: string;
};

type Achievement = {
  id: string;
  title: string;
  desc: string;
  icon: string;
};

type ComboPopup = {
  text: string;
  color: string;
  id: number;
};

// Level thresholds: [minXP, maxXP]
const LEVELS = [
  [0, 100],
  [100, 300],
  [300, 600],
  [600, 1000],
  [1000, 1500],
  [1500, 2200],
  [2200, 3000],
  [3000, 4000],
  [4000, 5500],
  [5500, 999999],
];

function getLevel(xp: number): number {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (xp >= LEVELS[i][0]) return i + 1;
  }
  return 1;
}

function getLevelProgress(xp: number): number {
  const lvl = getLevel(xp) - 1;
  const [min, max] = LEVELS[lvl] || [0, 100];
  return Math.min(100, ((xp - min) / (max - min)) * 100);
}

function getMultiplier(streak: number): number {
  if (streak >= 20) return 10;
  if (streak >= 10) return 5;
  if (streak >= 5) return 3;
  if (streak >= 3) return 2;
  return 1;
}

function getStreakLabel(streak: number): { text: string; color: string } | null {
  if (streak >= 20) return { text: "GODLIKE!", color: "rainbow" };
  if (streak >= 10) return { text: "UNSTOPPABLE!", color: "#FFD700" };
  if (streak >= 5) return { text: "ON FIRE!", color: "#FF6B35" };
  if (streak >= 3) return { text: "COMBO!", color: "#60A5FA" };
  return null;
}

function getStars(score: number, accuracy: number): number {
  if (score >= 800 && accuracy >= 90) return 3;
  if (score >= 400 && accuracy >= 70) return 2;
  return 1;
}

// Daily streak helpers
function getDailyStreak(): number {
  if (typeof window === "undefined") return 0;
  const raw = localStorage.getItem("dlf_daily_streak");
  if (!raw) return 0;
  try {
    const data = JSON.parse(raw);
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    if (data.lastDate === today) return data.count;
    if (data.lastDate === yesterday) return data.count; // will be incremented on play
    return 0; // streak broken
  } catch { return 0; }
}

function bumpDailyStreak(): number {
  if (typeof window === "undefined") return 1;
  const raw = localStorage.getItem("dlf_daily_streak");
  const today = new Date().toDateString();
  let count = 1;
  if (raw) {
    try {
      const data = JSON.parse(raw);
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      if (data.lastDate === today) return data.count;
      if (data.lastDate === yesterday) count = data.count + 1;
    } catch {}
  }
  localStorage.setItem("dlf_daily_streak", JSON.stringify({ lastDate: today, count }));
  return count;
}

function getHighScore(): number {
  if (typeof window === "undefined") return 0;
  return parseInt(localStorage.getItem("dlf_high_score") || "0", 10);
}

function setHighScore(score: number) {
  if (typeof window === "undefined") return;
  const prev = getHighScore();
  if (score > prev) localStorage.setItem("dlf_high_score", String(score));
}

function getTotalXP(): number {
  if (typeof window === "undefined") return 0;
  return parseInt(localStorage.getItem("dlf_total_xp") || "0", 10);
}

function addTotalXP(xp: number): number {
  if (typeof window === "undefined") return xp;
  const total = getTotalXP() + xp;
  localStorage.setItem("dlf_total_xp", String(total));
  return total;
}

// Sample challenges — same data, same honeypot logic
const SAMPLE_CHALLENGES: Challenge[] = [
  // Honeypots — images MATCH their target+groundTruth
  { id: 1, imageUrl: "https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=400", target: "car", aiPrediction: "YES", aiConfidence: 0.92, isHoneypot: true, groundTruth: "YES" },        // car photo → "is this a car?" → YES
  { id: 2, imageUrl: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400", target: "car", aiPrediction: "NO", aiConfidence: 0.95, isHoneypot: true, groundTruth: "NO" },          // mountain photo → "is this a car?" → NO
  { id: 3, imageUrl: "https://images.unsplash.com/photo-1517849845537-4d257902454a?w=400", target: "dog", aiPrediction: "YES", aiConfidence: 0.96, isHoneypot: true, groundTruth: "YES" },         // dog photo → "is this a dog?" → YES
  { id: 4, imageUrl: "https://images.unsplash.com/photo-1526336024174-e58f5cdd8e13?w=400", target: "dog", aiPrediction: "NO", aiConfidence: 0.90, isHoneypot: true, groundTruth: "NO" },           // cat photo → "is this a dog?" → NO
  // Real challenges — need human/agent verification
  { id: 5, imageUrl: "https://images.unsplash.com/photo-1543466835-00a7907e9de1?w=400", target: "dog", aiPrediction: "YES", aiConfidence: 0.78, isHoneypot: false },            // dog photo
  { id: 6, imageUrl: "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=400", target: "cat", aiPrediction: "YES", aiConfidence: 0.91, isHoneypot: false },           // cat photo
  { id: 7, imageUrl: "https://images.unsplash.com/photo-1444464666168-49d633b86797?w=400", target: "bird", aiPrediction: "YES", aiConfidence: 0.73, isHoneypot: false },          // bird photo
  { id: 8, imageUrl: "https://images.unsplash.com/photo-1566933293069-b55c7f326dd4?w=400", target: "car", aiPrediction: "YES", aiConfidence: 0.88, isHoneypot: false },           // car photo
  { id: 9, imageUrl: "https://images.unsplash.com/photo-1501594907352-04cda38ebc29?w=400", target: "fire hydrant", aiPrediction: "NO", aiConfidence: 0.89, isHoneypot: false },   // bridge photo → no fire hydrant
  { id: 10, imageUrl: "https://images.unsplash.com/photo-1518791841217-8f162f1e1131?w=400", target: "cat", aiPrediction: "YES", aiConfidence: 0.84, isHoneypot: false },          // cat photo
];

/* ------------------------------------------------------------------ */
/* CSS Keyframes (injected once)                                       */
/* ------------------------------------------------------------------ */

const GAME_STYLES = `
@keyframes flyUp {
  0% { opacity: 1; transform: translateY(0) scale(1); }
  70% { opacity: 1; transform: translateY(-80px) scale(1.3); }
  100% { opacity: 0; transform: translateY(-120px) scale(0.8); }
}
@keyframes shakeX {
  0%, 100% { transform: translateX(0); }
  10%, 30%, 50%, 70%, 90% { transform: translateX(-6px); }
  20%, 40%, 60%, 80% { transform: translateX(6px); }
}
@keyframes goldFlash {
  0% { box-shadow: 0 0 0 0 rgba(16,185,129,0.6); }
  50% { box-shadow: 0 0 40px 10px rgba(16,185,129,0.3); }
  100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); }
}
@keyframes wrongFlash {
  0% { box-shadow: 0 0 0 0 rgba(239,68,68,0.6); }
  50% { box-shadow: 0 0 40px 10px rgba(239,68,68,0.3); }
  100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
}
@keyframes comboSlam {
  0% { opacity: 0; transform: scale(3) rotate(-5deg); }
  40% { opacity: 1; transform: scale(1) rotate(0deg); }
  60% { transform: scale(1.1) rotate(1deg); }
  100% { opacity: 0; transform: scale(0.8) rotate(-2deg); }
}
@keyframes levelUp {
  0% { opacity: 0; transform: scale(0.5) translateY(30px); }
  30% { opacity: 1; transform: scale(1.2) translateY(-10px); }
  50% { transform: scale(1) translateY(0); }
  80% { opacity: 1; transform: scale(1.05); }
  100% { opacity: 0; transform: scale(0.9) translateY(-20px); }
}
@keyframes slotRoll {
  0% { transform: translateY(-100%); opacity: 0; }
  60% { transform: translateY(10%); opacity: 1; }
  80% { transform: translateY(-5%); }
  100% { transform: translateY(0); }
}
@keyframes pulseGlow {
  0%, 100% { box-shadow: 0 0 10px 2px rgba(239,68,68,0.3); }
  50% { box-shadow: 0 0 25px 8px rgba(239,68,68,0.6); }
}
@keyframes achievementSlide {
  0% { transform: translateX(120%); opacity: 0; }
  15% { transform: translateX(0); opacity: 1; }
  85% { transform: translateX(0); opacity: 1; }
  100% { transform: translateX(120%); opacity: 0; }
}
@keyframes starPop {
  0% { transform: scale(0) rotate(-30deg); opacity: 0; }
  60% { transform: scale(1.3) rotate(5deg); opacity: 1; }
  100% { transform: scale(1) rotate(0deg); opacity: 1; }
}
@keyframes playPulse {
  0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(37,99,235,0.5); }
  50% { transform: scale(1.03); box-shadow: 0 0 20px 5px rgba(37,99,235,0.3); }
}
@keyframes particleBurst {
  0% { opacity: 1; transform: translate(0, 0) scale(1); }
  100% { opacity: 0; transform: translate(var(--px, 30px), var(--py, -40px)) scale(0); }
}
@keyframes xpFill {
  from { width: var(--from-width, 0%); }
  to { width: var(--to-width, 100%); }
}
@keyframes badgeBounce {
  0% { transform: scale(0); }
  50% { transform: scale(1.4); }
  70% { transform: scale(0.9); }
  100% { transform: scale(1); }
}
@keyframes rainbowBorder {
  0% { border-color: #ff0000; }
  16% { border-color: #ff8800; }
  33% { border-color: #ffdd00; }
  50% { border-color: #00dd00; }
  66% { border-color: #0088ff; }
  83% { border-color: #8800ff; }
  100% { border-color: #ff0000; }
}
@keyframes scoreRollUp {
  0% { transform: translateY(100%); opacity: 0; }
  100% { transform: translateY(0); opacity: 1; }
}
@keyframes timerPanic {
  0%, 100% { color: #f87171; text-shadow: 0 0 8px rgba(248,113,113,0.5); }
  50% { color: #fca5a5; text-shadow: 0 0 20px rgba(248,113,113,0.8); }
}
`;

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function PlayPage() {
  const [mode, setMode] = useState<GameMode>("menu");
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [score, setScore] = useState(0);
  const [displayScore, setDisplayScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [timeLeft, setTimeLeft] = useState(60);
  const [challengeStartTime, setChallengeStartTime] = useState(0);
  const [showFeedback, setShowFeedback] = useState<"correct" | "wrong" | null>(null);
  const [trustScore, setTrustScore] = useState(100);
  const [floatingPoints, setFloatingPoints] = useState<FloatingPoint[]>([]);
  const [comboPopup, setComboPopup] = useState<ComboPopup | null>(null);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [showLevelUp, setShowLevelUp] = useState(false);
  const [prevLevel, setPrevLevel] = useState(1);
  const [lightningBadge, setLightningBadge] = useState(false);
  const [dailyStreak, setDailyStreak] = useState(0);
  const [highScore, setHighScoreState] = useState(0);
  const [totalXP, setTotalXP] = useState(0);
  const [resultsRevealed, setResultsRevealed] = useState(false);
  const [shakeScreen, setShakeScreen] = useState(false);
  const [earnedAchievements, setEarnedAchievements] = useState<Achievement[]>([]);
  const [showParticles, setShowParticles] = useState(false);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const fpIdRef = useRef(0);
  const achievedRef = useRef<Set<string>>(new Set());
  const comboIdRef = useRef(0);

  // Inject styles once
  useEffect(() => {
    if (document.getElementById("flywheel-styles")) return;
    const style = document.createElement("style");
    style.id = "flywheel-styles";
    style.textContent = GAME_STYLES;
    document.head.appendChild(style);
  }, []);

  // Load persisted data
  useEffect(() => {
    setDailyStreak(getDailyStreak());
    setHighScoreState(getHighScore());
    setTotalXP(getTotalXP());
  }, []);

  // Animated score counter
  useEffect(() => {
    if (displayScore === score) return;
    const diff = score - displayScore;
    const step = Math.max(1, Math.ceil(diff / 12));
    const t = setTimeout(() => {
      setDisplayScore((d) => Math.min(d + step, score));
    }, 30);
    return () => clearTimeout(t);
  }, [score, displayScore]);

  // Start game
  const startGame = useCallback((gameMode: "filter" | "bbox") => {
    const shuffled = [...SAMPLE_CHALLENGES].sort(() => Math.random() - 0.5);
    setChallenges(shuffled);
    setCurrentIdx(0);
    setAnswers([]);
    setScore(0);
    setDisplayScore(0);
    setStreak(0);
    setBestStreak(0);
    setTimeLeft(60);
    setTrustScore(100);
    setMode(gameMode);
    setChallengeStartTime(Date.now());
    setShowFeedback(null);
    setFloatingPoints([]);
    setComboPopup(null);
    setAchievements([]);
    setShowLevelUp(false);
    setLightningBadge(false);
    setResultsRevealed(false);
    setShakeScreen(false);
    setEarnedAchievements([]);
    setShowParticles(false);
    achievedRef.current = new Set();
    const xp = getTotalXP();
    setTotalXP(xp);
    setPrevLevel(getLevel(xp));
    bumpDailyStreak();
    setDailyStreak(getDailyStreak());
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

  // On results
  useEffect(() => {
    if (mode !== "results") return;
    setHighScore(score);
    setHighScoreState(Math.max(getHighScore(), score));
    const newTotal = addTotalXP(score);
    setTotalXP(newTotal);

    // Check level up
    const newLvl = getLevel(newTotal);
    if (newLvl > prevLevel) {
      setShowLevelUp(true);
      setTimeout(() => setShowLevelUp(false), 2500);
    }

    // Delay results reveal for slot machine effect
    setTimeout(() => setResultsRevealed(true), 600);

    // Check achievements
    const earned: Achievement[] = [];
    if (answers.length >= 10 && !achievedRef.current.has("first10")) {
      earned.push({ id: "first10", title: "First 10!", desc: "Labeled 10 images", icon: "10" });
      achievedRef.current.add("first10");
    }
    const fastAnswers = answers.filter(a => a.timeMs < 1000).length;
    if (fastAnswers >= 5 && !achievedRef.current.has("speedDemon")) {
      earned.push({ id: "speedDemon", title: "Speed Demon!", desc: "5 answers under 1 second", icon: "zap" });
      achievedRef.current.add("speedDemon");
    }
    const acc = answers.length > 0 ? answers.filter(a => a.correct).length / answers.length : 0;
    if (acc === 1 && answers.length >= 5 && !achievedRef.current.has("perfect")) {
      earned.push({ id: "perfect", title: "Perfect Round!", desc: "100% accuracy", icon: "star" });
      achievedRef.current.add("perfect");
    }
    if (trustScore >= 90 && !achievedRef.current.has("trustMaster")) {
      earned.push({ id: "trustMaster", title: "Trust Master!", desc: "Trust score 90%+", icon: "shield" });
      achievedRef.current.add("trustMaster");
    }
    if (bestStreak >= 10 && !achievedRef.current.has("streak10")) {
      earned.push({ id: "streak10", title: "Streak King!", desc: "10+ combo streak", icon: "fire" });
      achievedRef.current.add("streak10");
    }
    if (score > getHighScore() && score > 0 && !achievedRef.current.has("newRecord")) {
      earned.push({ id: "newRecord", title: "New Record!", desc: `Beat your best: ${score} pts`, icon: "crown" });
      achievedRef.current.add("newRecord");
    }
    setEarnedAchievements(earned);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Spawn floating point
  const spawnFloatingPoint = useCallback((value: string, color: string) => {
    const id = ++fpIdRef.current;
    const x = 40 + Math.random() * 20; // percentage
    const y = 30 + Math.random() * 10;
    setFloatingPoints((prev) => [...prev, { id, value, x, y, color }]);
    setTimeout(() => {
      setFloatingPoints((prev) => prev.filter((p) => p.id !== id));
    }, 1000);
  }, []);

  // Trigger achievement popup
  const triggerAchievement = useCallback((ach: Achievement) => {
    setAchievements((prev) => [...prev, ach]);
    setTimeout(() => {
      setAchievements((prev) => prev.filter((a) => a.id !== ach.id));
    }, 3000);
  }, []);

  // Handle answer
  const handleAnswer = useCallback((userAnswer: "YES" | "NO") => {
    const challenge = challenges[currentIdx];
    if (!challenge) return;

    const timeMs = Date.now() - challengeStartTime;

    // Honeypot trust logic (unchanged)
    let correct: boolean;
    if (challenge.isHoneypot && challenge.groundTruth) {
      correct = userAnswer === challenge.groundTruth;
      setTrustScore((prev) => correct
        ? Math.min(100, prev + 5)
        : Math.max(0, prev - 25)
      );
    } else {
      correct = userAnswer === challenge.aiPrediction;
    }

    const newStreak = correct ? streak + 1 : 0;
    const multiplier = getMultiplier(newStreak);
    const isLightning = timeMs < 1000 && correct;
    const basePoints = correct ? 10 : 0;
    const speedBonus = correct ? Math.max(0, Math.floor((3000 - timeMs) / 100)) : 0;
    const pointsEarned = (basePoints + speedBonus) * multiplier * (isLightning ? 2 : 1);

    setAnswers((prev) => [...prev, { challengeId: challenge.id, userAnswer, correct, timeMs, wasHoneypot: challenge.isHoneypot }]);
    setScore((prev) => prev + pointsEarned);
    setStreak(newStreak);

    // Submit to reward pool for GRPO training
    fetch("/api/rewards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url: challenge.imageUrl,
        target: challenge.target,
        label: userAnswer,
        reward: correct ? 3 : -3,
        source: "human:web",
        source_type: "human",
        trust_score: trustScore,
        is_honeypot: challenge.isHoneypot,
        honeypot_correct: challenge.isHoneypot ? correct : undefined,
        response_time_ms: timeMs,
        streak: newStreak,
      }),
    }).catch(() => {});
    if (newStreak > bestStreak) setBestStreak(newStreak);

    // Visual feedback
    if (correct) {
      setShowFeedback("correct");
      spawnFloatingPoint(`+${pointsEarned}`, isLightning ? "#FFD700" : "#10B981");
      if (isLightning) {
        setLightningBadge(true);
        setTimeout(() => setLightningBadge(false), 1200);
      }
      // Particles on streaks
      if (newStreak >= 3) {
        setShowParticles(true);
        setTimeout(() => setShowParticles(false), 600);
      }
    } else {
      setShowFeedback("wrong");
      setShakeScreen(true);
      setTimeout(() => setShakeScreen(false), 500);
    }

    // Combo popup at milestones
    const label = getStreakLabel(newStreak);
    if (label && (newStreak === 3 || newStreak === 5 || newStreak === 10 || newStreak === 20)) {
      const cid = ++comboIdRef.current;
      setComboPopup({ text: label.text, color: label.color, id: cid });
      setTimeout(() => {
        setComboPopup((prev) => (prev && prev.id === cid ? null : prev));
      }, 1200);
    }

    // Inline achievements
    const totalAnswers = answers.length + 1;
    if (totalAnswers === 10 && !achievedRef.current.has("first10_live")) {
      achievedRef.current.add("first10_live");
      triggerAchievement({ id: "first10_live", title: "First 10!", desc: "Labeled 10 images", icon: "10" });
    }
    if (isLightning) {
      const lightningCount = answers.filter(a => a.timeMs < 1000 && a.correct).length + 1;
      if (lightningCount === 5 && !achievedRef.current.has("speedDemon_live")) {
        achievedRef.current.add("speedDemon_live");
        triggerAchievement({ id: "speedDemon_live", title: "Speed Demon!", desc: "5 lightning answers", icon: "zap" });
      }
    }

    // Level up check
    const newScore = score + pointsEarned;
    const newTotal = getTotalXP() + pointsEarned;
    const oldLvl = getLevel(getTotalXP());
    const checkLvl = getLevel(newTotal);
    if (checkLvl > oldLvl) {
      setShowLevelUp(true);
      setTimeout(() => setShowLevelUp(false), 2000);
    }

    // Advance to next
    setTimeout(() => {
      setShowFeedback(null);
      if (currentIdx + 1 < challenges.length) {
        setCurrentIdx((prev) => prev + 1);
        setChallengeStartTime(Date.now());
      } else {
        const reshuffled = [...SAMPLE_CHALLENGES].sort(() => Math.random() - 0.5);
        setChallenges(reshuffled);
        setCurrentIdx(0);
        setChallengeStartTime(Date.now());
      }
    }, 350);
  }, [challenges, currentIdx, challengeStartTime, streak, bestStreak, score, answers, spawnFloatingPoint, triggerAchievement]);

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
  const currentMultiplier = getMultiplier(streak);
  const currentLevel = getLevel(totalXP + score);
  const levelProgress = getLevelProgress(totalXP + score);
  const streakLabel = getStreakLabel(streak);
  const stars = getStars(score, accuracy);
  const isPerfectRound = answers.length >= 5 && accuracy === 100;
  const perfectBonus = isPerfectRound ? 500 : 0;

  return (
    <main
      className="min-h-screen bg-zinc-950 text-zinc-100"
      style={shakeScreen ? { animation: "shakeX 0.5s ease-in-out" } : undefined}
    >
      <SiteNav variant="transparent" />

      {/* XP Bar (under nav, during gameplay) */}
      {(mode === "filter" || mode === "bbox") && (
        <div className="fixed top-14 left-0 right-0 z-40 h-2 bg-zinc-900">
          <div
            className="h-full rounded-r-full transition-all duration-500"
            style={{
              width: `${levelProgress}%`,
              background: "linear-gradient(90deg, #2563EB, #06B6D4, #10B981)",
            }}
          />
          <div className="absolute right-3 -top-0.5 text-[10px] font-bold text-zinc-500">
            LVL {currentLevel}
          </div>
        </div>
      )}

      {/* Floating points */}
      {floatingPoints.map((fp) => (
        <div
          key={fp.id}
          className="fixed z-50 pointer-events-none font-black text-2xl"
          style={{
            left: `${fp.x}%`,
            top: `${fp.y}%`,
            color: fp.color,
            animation: "flyUp 1s ease-out forwards",
            textShadow: `0 0 10px ${fp.color}`,
          }}
        >
          {fp.value}
        </div>
      ))}

      {/* Combo popup */}
      {comboPopup && (
        <div
          className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center"
        >
          <div
            className="font-black text-5xl sm:text-7xl tracking-tight"
            style={{
              color: comboPopup.color === "rainbow" ? "transparent" : comboPopup.color,
              background: comboPopup.color === "rainbow" ? "linear-gradient(90deg, #ff0000, #ff8800, #ffdd00, #00dd00, #0088ff, #8800ff)" : undefined,
              WebkitBackgroundClip: comboPopup.color === "rainbow" ? "text" : undefined,
              animation: "comboSlam 1.2s ease-out forwards",
              textShadow: comboPopup.color !== "rainbow" ? `0 0 30px ${comboPopup.color}44` : undefined,
            }}
          >
            {comboPopup.text}
          </div>
        </div>
      )}

      {/* Level up popup */}
      {showLevelUp && (
        <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center">
          <div
            className="font-black text-4xl sm:text-6xl tracking-tight"
            style={{
              background: "linear-gradient(90deg, #FFD700, #FFA500, #FFD700)",
              WebkitBackgroundClip: "text",
              color: "transparent",
              animation: "levelUp 2s ease-out forwards",
              textShadow: "0 0 40px rgba(255,215,0,0.3)",
            }}
          >
            LEVEL UP!
          </div>
        </div>
      )}

      {/* Lightning badge */}
      {lightningBadge && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
          <div
            className="bg-yellow-400 text-black font-black text-sm px-4 py-1.5 rounded-full"
            style={{ animation: "badgeBounce 0.4s ease-out, flyUp 1.2s ease-out 0.4s forwards" }}
          >
            LIGHTNING x2
          </div>
        </div>
      )}

      {/* Achievement popups */}
      <div className="fixed top-20 right-4 z-50 space-y-2 pointer-events-none">
        {achievements.map((ach) => (
          <div
            key={ach.id}
            className="flex items-center gap-3 bg-zinc-900 border border-yellow-500/30 rounded-xl px-4 py-3 shadow-lg shadow-yellow-500/10"
            style={{ animation: "achievementSlide 3s ease-in-out forwards" }}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-yellow-500/20 text-yellow-400 font-black text-sm">
              {ach.icon}
            </div>
            <div>
              <div className="font-bold text-yellow-400 text-sm">{ach.title}</div>
              <div className="text-xs text-zinc-400">{ach.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Particle burst overlay */}
      {showParticles && (
        <div className="fixed inset-0 z-40 pointer-events-none overflow-hidden">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="absolute left-1/2 top-1/2 w-2 h-2 rounded-full"
              style={{
                backgroundColor: ["#FFD700", "#10B981", "#3B82F6", "#F59E0B", "#EC4899", "#8B5CF6"][i % 6],
                // @ts-expect-error CSS custom properties
                "--px": `${(Math.random() - 0.5) * 200}px`,
                "--py": `${(Math.random() - 0.5) * 200}px`,
                animation: `particleBurst 0.6s ease-out forwards`,
                animationDelay: `${i * 30}ms`,
              }}
            />
          ))}
        </div>
      )}

      <div className="pt-14">
        {/* ==================== MENU ==================== */}
        {mode === "menu" && (
          <div className="mx-auto max-w-3xl px-6 pt-16 pb-16 text-center">
            {/* Daily streak badge */}
            {dailyStreak > 0 && (
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-950/20 px-4 py-1.5 text-[13px] text-orange-400 font-semibold">
                Day {dailyStreak} streak
              </div>
            )}

            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/80 px-4 py-1.5 text-[13px] text-zinc-400">
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
              Label images, earn XP, level up, climb the leaderboard.
              Every answer trains the AI to see better.
            </p>

            {/* Player stats */}
            <div className="mt-8 flex items-center justify-center gap-6 text-sm">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-3">
                <div className="text-2xl font-black text-blue-400">LVL {getLevel(totalXP)}</div>
                <div className="text-xs text-zinc-500 mt-0.5">Level</div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-3">
                <div className="text-2xl font-black" style={{ color: "#FFD700" }}>{highScore}</div>
                <div className="text-xs text-zinc-500 mt-0.5">High Score</div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-3">
                <div className="text-2xl font-black text-emerald-400">{totalXP}</div>
                <div className="text-xs text-zinc-500 mt-0.5">Total XP</div>
              </div>
            </div>

            {/* XP progress to next level */}
            <div className="mt-4 max-w-xs mx-auto">
              <div className="flex justify-between text-[10px] text-zinc-500 mb-1">
                <span>Level {getLevel(totalXP)}</span>
                <span>Level {getLevel(totalXP) + 1}</span>
              </div>
              <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${getLevelProgress(totalXP)}%`,
                    background: "linear-gradient(90deg, #2563EB, #06B6D4)",
                  }}
                />
              </div>
            </div>

            <div className="mt-12 grid gap-5 sm:grid-cols-3 max-w-2xl mx-auto">
              <button
                onClick={() => startGame("filter")}
                className="group rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6 text-left transition hover:border-blue-500/30 hover:bg-zinc-900/60"
                style={{ animation: "playPulse 2s ease-in-out infinite" }}
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

              <a
                href="/play/docs"
                className="group rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6 text-left transition hover:border-blue-500/30 hover:bg-zinc-900/60 relative"
              >
                <span className="absolute top-3 right-3 rounded-full bg-blue-600/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-400">
                  New
                </span>
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600/10 text-2xl mb-4">
                  ¶
                </div>
                <h3 className="text-lg font-semibold">Document Flywheel</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  Verify document layout. Is this block a header? YES or NO.
                  Trains a doc-layout model.
                </p>
                <div className="mt-3 text-xs text-blue-400 group-hover:text-blue-300">
                  Play doc mode &rarr;
                </div>
              </a>

              <a
                href="/play/spin"
                className="group rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6 text-left transition hover:border-amber-500/30 hover:bg-zinc-900/60 relative"
              >
                <span className="absolute top-3 right-3 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
                  Casino
                </span>
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-600/10 text-2xl mb-4">
                  🎰
                </div>
                <h3 className="text-lg font-semibold">Spin Wheel</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  Spin the casino wheel. Land on a label type. JACKPOT = 3x points!
                </p>
                <div className="mt-3 text-xs text-amber-400 group-hover:text-amber-300">
                  Spin to win &rarr;
                </div>
              </a>
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
                  <span>Answer YES or NO. Under 1 second = LIGHTNING badge + 2x points!</span>
                </div>
                <div className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600/20 text-blue-400 text-xs font-bold">3</span>
                  <span>Build streaks: 3x COMBO, 5x FIRE, 10x UNSTOPPABLE, 20x GODLIKE!</span>
                </div>
                <div className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600/20 text-blue-400 text-xs font-bold">4</span>
                  <span>Your answers train the AI -- every label makes the model smarter.</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ==================== FILTER GAME ==================== */}
        {mode === "filter" && current && (
          <div className="mx-auto max-w-2xl px-6 pt-10">
            {/* Stats bar */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-4 sm:gap-6 text-sm">
                <div>
                  <span className="text-zinc-500">Streak </span>
                  <span className="font-bold text-cyan-400">{streak}</span>
                  {currentMultiplier > 1 && (
                    <span
                      className="ml-1.5 text-xs font-black px-1.5 py-0.5 rounded-full"
                      style={{
                        background: streakLabel?.color === "rainbow"
                          ? "linear-gradient(90deg, #ff0000, #ff8800, #ffdd00, #00dd00, #0088ff)"
                          : (streakLabel?.color || "#FFD700"),
                        color: "#000",
                      }}
                    >
                      {currentMultiplier}x
                    </span>
                  )}
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
            </div>

            {/* Timer bar */}
            <div
              className="h-1.5 w-full rounded-full bg-zinc-800 mb-5 overflow-hidden"
              style={timeLeft <= 10 ? { animation: "pulseGlow 1s ease-in-out infinite" } : undefined}
            >
              <div
                className="h-full rounded-full transition-all duration-1000"
                style={{
                  width: `${(timeLeft / 60) * 100}%`,
                  background: timeLeft <= 10
                    ? "linear-gradient(90deg, #EF4444, #F97316)"
                    : timeLeft <= 20
                      ? "linear-gradient(90deg, #F59E0B, #EAB308)"
                      : "linear-gradient(90deg, #2563EB, #06B6D4)",
                }}
              />
            </div>

            {/* Question */}
            <div className="text-center mb-4">
              <span className="text-zinc-400">Is this a </span>
              <span className="text-xl font-bold text-white">{current.target}</span>
              <span className="text-zinc-400">?</span>
            </div>

            {/* Image */}
            <div
              className="relative rounded-2xl overflow-hidden border-2 bg-zinc-900/50 aspect-[4/3]"
              style={{
                borderColor: showFeedback === "correct"
                  ? "#10B981"
                  : showFeedback === "wrong"
                    ? "#EF4444"
                    : streak >= 20
                      ? undefined
                      : "#27272a",
                animation: showFeedback === "correct"
                  ? "goldFlash 0.4s ease-out"
                  : showFeedback === "wrong"
                    ? "wrongFlash 0.4s ease-out"
                    : streak >= 20
                      ? "rainbowBorder 1s linear infinite"
                      : undefined,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={current.imageUrl}
                alt=""
                className="w-full h-full object-cover"
              />

              {/* Feedback overlay */}
              {showFeedback && (
                <div className={`absolute inset-0 flex items-center justify-center transition-all ${
                  showFeedback === "correct" ? "bg-emerald-500/15" : "bg-red-500/15"
                }`}>
                  <div
                    className={`text-7xl font-black ${
                      showFeedback === "correct" ? "text-emerald-400" : "text-red-400"
                    }`}
                    style={{ animation: "badgeBounce 0.35s ease-out" }}
                  >
                    {showFeedback === "correct" ? "+" : "X"}
                  </div>
                </div>
              )}

              {/* AI confidence badge */}
              <div className="absolute top-3 right-3 rounded-full bg-black/60 px-3 py-1 text-[11px] text-zinc-400 backdrop-blur-sm">
                AI: {Math.round(current.aiConfidence * 100)}%
              </div>

              {/* Streak indicator on image */}
              {streak >= 3 && (
                <div className="absolute top-3 left-3 rounded-full bg-black/60 backdrop-blur-sm px-3 py-1">
                  <span
                    className="text-sm font-black"
                    style={{
                      color: streakLabel?.color === "rainbow" ? undefined : streakLabel?.color,
                      background: streakLabel?.color === "rainbow" ? "linear-gradient(90deg, #ff0000, #ff8800, #ffdd00, #00dd00, #0088ff, #8800ff)" : undefined,
                      WebkitBackgroundClip: streakLabel?.color === "rainbow" ? "text" : undefined,
                      ...(streakLabel?.color === "rainbow" ? { color: "transparent" } : {}),
                    }}
                  >
                    {streak} STREAK
                  </span>
                </div>
              )}
            </div>

            {/* Answer buttons -- BIG for mobile */}
            <div className="mt-5 grid grid-cols-2 gap-4">
              <button
                onClick={() => handleAnswer("NO")}
                className="h-20 sm:h-16 rounded-2xl border-2 border-zinc-700 bg-zinc-900/50 text-2xl sm:text-xl font-bold text-zinc-300 transition-all active:scale-[0.95] hover:border-red-500/50 hover:bg-red-950/20 hover:text-red-400 select-none"
                style={{ WebkitTapHighlightColor: "transparent" }}
              >
                NO
                <span className="block text-[10px] font-normal text-zinc-500 mt-0.5">
                  press N or &larr;
                </span>
              </button>
              <button
                onClick={() => handleAnswer("YES")}
                className="h-20 sm:h-16 rounded-2xl border-2 border-zinc-700 bg-zinc-900/50 text-2xl sm:text-xl font-bold text-zinc-300 transition-all active:scale-[0.95] hover:border-emerald-500/50 hover:bg-emerald-950/20 hover:text-emerald-400 select-none"
                style={{ WebkitTapHighlightColor: "transparent" }}
              >
                YES
                <span className="block text-[10px] font-normal text-zinc-500 mt-0.5">
                  press Y or &rarr;
                </span>
              </button>
            </div>

            {/* Multiplier guide */}
            <div className="mt-4 flex items-center justify-center gap-3 text-[10px] text-zinc-600">
              <span className={streak >= 3 ? "text-blue-400 font-bold" : ""}>3=2x</span>
              <span className={streak >= 5 ? "text-orange-400 font-bold" : ""}>5=3x</span>
              <span className={streak >= 10 ? "text-yellow-400 font-bold" : ""}>10=5x</span>
              <span className={streak >= 20 ? "font-bold" : ""} style={streak >= 20 ? { background: "linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f)", WebkitBackgroundClip: "text", color: "transparent" } : undefined}>20=10x</span>
            </div>
          </div>
        )}

        {/* ==================== RESULTS ==================== */}
        {mode === "results" && (
          <div className="mx-auto max-w-lg px-6 pt-12 pb-8 text-center">
            {/* Stars */}
            <div className="flex justify-center gap-3 mb-4">
              {[1, 2, 3].map((s) => (
                <div
                  key={s}
                  className="text-4xl"
                  style={{
                    opacity: s <= stars ? 1 : 0.2,
                    color: s <= stars ? "#FFD700" : "#52525b",
                    animation: s <= stars ? `starPop 0.5s ease-out ${s * 0.2}s both` : undefined,
                    filter: s <= stars ? "drop-shadow(0 0 8px rgba(255,215,0,0.4))" : undefined,
                  }}
                >
                  *
                </div>
              ))}
            </div>

            <h2 className="text-4xl font-bold tracking-tight">
              {score >= 1000 ? "LEGENDARY!" : score >= 500 ? "Amazing!" : score >= 200 ? "Nice work!" : "Good try!"}
            </h2>
            <p className="mt-2 text-zinc-400">
              You labeled {answers.length} images and helped train the AI.
            </p>

            {/* Score display -- slot machine reveal */}
            <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-8 overflow-hidden">
              <div className="overflow-hidden" style={{ height: "72px" }}>
                <div
                  className="font-black text-blue-400"
                  style={{
                    fontSize: "64px",
                    lineHeight: "72px",
                    animation: resultsRevealed ? "slotRoll 0.8s ease-out" : undefined,
                    opacity: resultsRevealed ? 1 : 0,
                  }}
                >
                  {score + perfectBonus}
                </div>
              </div>
              <div className="text-sm text-zinc-500 mt-1">
                points
                {perfectBonus > 0 && <span className="text-yellow-400 ml-2">(+500 PERFECT ROUND!)</span>}
              </div>

              <div className="mt-6 grid grid-cols-4 gap-3">
                <div>
                  <div className="text-2xl font-bold">{answers.length}</div>
                  <div className="text-[11px] text-zinc-500">Labeled</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-emerald-400">{accuracy}%</div>
                  <div className="text-[11px] text-zinc-500">Accuracy</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-cyan-400">{bestStreak}</div>
                  <div className="text-[11px] text-zinc-500">Best Streak</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-zinc-300">{avgTime}ms</div>
                  <div className="text-[11px] text-zinc-500">Avg Time</div>
                </div>
              </div>
            </div>

            {/* New high score? */}
            {score + perfectBonus > highScore && score > 0 && (
              <div
                className="mt-4 rounded-xl border border-yellow-500/30 bg-yellow-950/20 px-4 py-3 font-bold text-yellow-400"
                style={{ animation: "badgeBounce 0.5s ease-out" }}
              >
                NEW HIGH SCORE! Beat your previous best!
              </div>
            )}

            {/* XP + Level progress */}
            <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-zinc-300">Level {currentLevel}</span>
                <span className="text-sm font-bold text-blue-400">+{score + perfectBonus} XP</span>
              </div>
              <div className="h-3 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${levelProgress}%`,
                    background: "linear-gradient(90deg, #2563EB, #06B6D4, #10B981)",
                    transition: "width 1.5s ease-out",
                  }}
                />
              </div>
              <div className="text-[10px] text-zinc-500 mt-1">
                {Math.round(levelProgress)}% to Level {currentLevel + 1}
              </div>
            </div>

            {/* Trust score + GRPO contribution */}
            <div className={`mt-4 rounded-2xl border p-4 text-sm ${
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
                <p className="text-zinc-400 text-left">
                  <span className="text-blue-400 font-semibold">{labelsAccepted} verified labels</span>
                  {" "}accepted for GRPO training. Honeypot accuracy: {honeypotAccuracy}%.
                  {honeypotAnswers.length > 0 && ` (${honeypotAnswers.filter(a => a.correct).length}/${honeypotAnswers.length} correct)`}
                </p>
              ) : (
                <p className="text-red-400 text-left">
                  Trust too low -- labels discarded. You missed too many verification checks.
                  Play again more carefully to contribute to training.
                </p>
              )}
            </div>

            {/* Achievements earned this round */}
            {earnedAchievements.length > 0 && (
              <div className="mt-4 rounded-2xl border border-yellow-500/20 bg-yellow-950/10 p-4">
                <div className="text-sm font-semibold text-yellow-400 mb-3 text-left">Achievements Unlocked</div>
                <div className="space-y-2">
                  {earnedAchievements.map((ach, i) => (
                    <div
                      key={ach.id}
                      className="flex items-center gap-3 text-left"
                      style={{ animation: `achievementSlide 3s ease-in-out ${i * 0.3}s both` }}
                    >
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-yellow-500/20 text-yellow-400 font-bold text-xs shrink-0">
                        {ach.icon}
                      </div>
                      <div>
                        <div className="text-sm font-bold text-yellow-300">{ach.title}</div>
                        <div className="text-xs text-zinc-500">{ach.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Leaderboard preview */}
            <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
              <div className="text-sm font-semibold text-zinc-300 mb-3 text-left">Leaderboard</div>
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between text-zinc-400">
                  <span><span className="text-yellow-400 font-bold mr-2">#1</span> LabelKing99</span>
                  <span className="font-mono">3,240</span>
                </div>
                <div className="flex items-center justify-between text-zinc-400">
                  <span><span className="text-zinc-300 font-bold mr-2">#2</span> DataWiz</span>
                  <span className="font-mono">2,890</span>
                </div>
                <div className="flex items-center justify-between text-zinc-400">
                  <span><span className="text-orange-400 font-bold mr-2">#3</span> AITrainer42</span>
                  <span className="font-mono">2,150</span>
                </div>
                <div className="flex items-center justify-between text-white font-bold border-t border-zinc-800 pt-2 mt-2">
                  <span><span className="text-blue-400 mr-2">#{Math.max(4, 50 - Math.floor(score / 20))}</span> You</span>
                  <span className="font-mono text-blue-400">{score + perfectBonus}</span>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
              <button
                onClick={() => startGame("filter")}
                className="rounded-xl bg-blue-600 px-8 py-4 text-lg font-bold text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-500 active:scale-[0.97]"
                style={{ animation: "playPulse 1.5s ease-in-out infinite" }}
              >
                Play Again
              </button>
              <button
                onClick={() => {
                  if (typeof navigator !== "undefined" && navigator.share) {
                    navigator.share({
                      title: "Flywheel Score",
                      text: `I scored ${score + perfectBonus} points labeling images on Flywheel! Can you beat me?`,
                    }).catch(() => {});
                  } else if (typeof navigator !== "undefined" && navigator.clipboard) {
                    navigator.clipboard.writeText(`I scored ${score + perfectBonus} points on Flywheel! Play at ${window.location.href}`);
                  }
                }}
                className="rounded-xl border border-zinc-700 px-8 py-4 text-base font-medium text-zinc-300 transition hover:bg-zinc-800 active:scale-[0.97]"
              >
                Share Score
              </button>
              <button
                onClick={() => setMode("menu")}
                className="rounded-xl border border-zinc-700 px-6 py-4 text-base font-medium text-zinc-300 transition hover:bg-zinc-800 active:scale-[0.97]"
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
