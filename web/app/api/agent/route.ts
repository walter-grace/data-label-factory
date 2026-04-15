import { NextRequest, NextResponse } from "next/server";

/**
 * Agent API — lets AI agents interact with Data Label Factory.
 *
 * Endpoints (via ?action=):
 *   GET  ?action=challenge     — get a labeling challenge (with honeypots)
 *   POST ?action=answer        — submit an answer to a challenge
 *   POST ?action=register      — register an agent + optional custom vision endpoint
 *   GET  ?action=stats         — get agent's stats (trust, labels, score)
 *   GET  ?action=leaderboard   — top agents by trust score
 *
 * Auth: Bearer token in Authorization header (agent API key)
 * For now: open access (no auth required for testing)
 */

const DLF_API = process.env.DLF_API_URL || "http://localhost:8400";

// In-memory store (production: use database)
type Agent = {
  id: string;
  name: string;
  type: "llm" | "vision" | "human" | "custom";
  trustScore: number;
  totalLabels: number;
  correctLabels: number;
  honeypotCorrect: number;
  honeypotTotal: number;
  score: number;
  customEndpoint?: string; // agent's own vision model URL
  registeredAt: string;
};

type PendingChallenge = {
  id: string;
  imageUrl: string;
  target: string;
  isHoneypot: boolean;
  groundTruth?: "YES" | "NO";
  issuedAt: number;
};

const agents = new Map<string, Agent>();
const pendingChallenges = new Map<string, PendingChallenge>();

// Sample challenge pool
const CHALLENGE_POOL = [
  { imageUrl: "https://images.unsplash.com/photo-1566933293069-b55c7f326dd4?w=400", target: "car", isHoneypot: true, groundTruth: "YES" as const },
  { imageUrl: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400", target: "car", isHoneypot: true, groundTruth: "NO" as const },
  { imageUrl: "https://images.unsplash.com/photo-1517849845537-4d257902454a?w=400", target: "dog", isHoneypot: true, groundTruth: "YES" as const },
  { imageUrl: "https://images.unsplash.com/photo-1526336024174-e58f5cdd8e13?w=400", target: "dog", isHoneypot: true, groundTruth: "NO" as const },
  { imageUrl: "https://images.unsplash.com/photo-1518791841217-8f162f1e1131?w=400", target: "cat", isHoneypot: false },
  { imageUrl: "https://images.unsplash.com/photo-1543466835-00a7907e9de1?w=400", target: "dog", isHoneypot: false },
  { imageUrl: "https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=400", target: "stop sign", isHoneypot: false },
  { imageUrl: "https://images.unsplash.com/photo-1583337130417-13104dec14a4?w=400", target: "cat", isHoneypot: false },
  { imageUrl: "https://images.unsplash.com/photo-1474511320723-9a56873571b7?w=400", target: "bird", isHoneypot: false },
  { imageUrl: "https://images.unsplash.com/photo-1501594907352-04cda38ebc29?w=400", target: "fire hydrant", isHoneypot: false },
];

function getOrCreateAgent(agentId: string): Agent {
  if (!agents.has(agentId)) {
    agents.set(agentId, {
      id: agentId,
      name: agentId,
      type: "llm",
      trustScore: 100,
      totalLabels: 0,
      correctLabels: 0,
      honeypotCorrect: 0,
      honeypotTotal: 0,
      score: 0,
      registeredAt: new Date().toISOString(),
    });
  }
  return agents.get(agentId)!;
}

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  const agentId = req.headers.get("x-agent-id") || req.nextUrl.searchParams.get("agent_id") || "anonymous";

  if (action === "challenge") {
    // Issue a random challenge
    const pool = CHALLENGE_POOL;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const challengeId = `ch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    pendingChallenges.set(challengeId, {
      id: challengeId,
      imageUrl: pick.imageUrl,
      target: pick.target,
      isHoneypot: pick.isHoneypot,
      groundTruth: pick.groundTruth,
      issuedAt: Date.now(),
    });

    // Don't reveal honeypot status or ground truth to the agent
    return NextResponse.json({
      challenge_id: challengeId,
      image_url: pick.imageUrl,
      target: pick.target,
      question: `Is this a ${pick.target}? Answer YES or NO.`,
    });
  }

  if (action === "stats") {
    const agent = getOrCreateAgent(agentId);
    return NextResponse.json({
      agent_id: agent.id,
      name: agent.name,
      trust_score: agent.trustScore,
      total_labels: agent.totalLabels,
      correct_labels: agent.correctLabels,
      accuracy: agent.totalLabels > 0 ? Math.round((agent.correctLabels / agent.totalLabels) * 100) : 0,
      honeypot_accuracy: agent.honeypotTotal > 0 ? Math.round((agent.honeypotCorrect / agent.honeypotTotal) * 100) : 100,
      score: agent.score,
      labels_accepted: agent.trustScore >= 50,
      custom_endpoint: agent.customEndpoint || null,
    });
  }

  if (action === "leaderboard") {
    const sorted = Array.from(agents.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((a) => ({
        name: a.name,
        score: a.score,
        trust: a.trustScore,
        labels: a.totalLabels,
        type: a.type,
      }));
    return NextResponse.json({ leaderboard: sorted });
  }

  return NextResponse.json({ error: "Unknown action. Use: challenge, answer, register, stats, leaderboard" }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  const agentId = req.headers.get("x-agent-id") || "anonymous";

  if (action === "answer") {
    const body = await req.json();
    const { challenge_id, answer } = body;

    if (!challenge_id || !answer) {
      return NextResponse.json({ error: "Missing challenge_id or answer" }, { status: 400 });
    }

    const challenge = pendingChallenges.get(challenge_id);
    if (!challenge) {
      return NextResponse.json({ error: "Unknown or expired challenge" }, { status: 404 });
    }

    pendingChallenges.delete(challenge_id);
    const agent = getOrCreateAgent(agentId);
    const userAnswer = answer.toUpperCase() as "YES" | "NO";

    let correct: boolean;
    let wasHoneypot = false;

    if (challenge.isHoneypot && challenge.groundTruth) {
      correct = userAnswer === challenge.groundTruth;
      wasHoneypot = true;
      agent.honeypotTotal++;
      if (correct) {
        agent.honeypotCorrect++;
        agent.trustScore = Math.min(100, agent.trustScore + 5);
      } else {
        agent.trustScore = Math.max(0, agent.trustScore - 25);
      }
    } else {
      // Real challenge — store the label for GRPO
      correct = true; // we accept the agent's label (validated by trust score)
    }

    agent.totalLabels++;
    if (correct) agent.correctLabels++;
    agent.score += correct ? 10 : 0;

    const accepted = agent.trustScore >= 50;

    // Submit to reward pool for GRPO training
    try {
      const rewardPayload = {
        image_url: challenge.imageUrl,
        target: challenge.target,
        label: userAnswer,
        reward: correct ? 3 : -3,
        source: `agent:${agentId}`,
        source_type: "agent",
        trust_score: agent.trustScore,
        is_honeypot: wasHoneypot,
        honeypot_correct: wasHoneypot ? correct : undefined,
        response_time_ms: Date.now() - challenge.issuedAt,
        streak: agent.correctLabels,
      };
      // Fire and forget — don't block the response
      fetch(`${req.nextUrl.origin}/api/rewards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rewardPayload),
      }).catch(() => {});
    } catch {}

    return NextResponse.json({
      correct,
      was_honeypot: wasHoneypot,
      trust_score: agent.trustScore,
      score: agent.score,
      label_accepted: accepted && !wasHoneypot,
      total_labels: agent.totalLabels,
    });
  }

  if (action === "register") {
    const body = await req.json();
    const { name, type, custom_endpoint } = body;
    const agent = getOrCreateAgent(agentId);
    agent.name = name || agentId;
    agent.type = type || "llm";
    if (custom_endpoint) agent.customEndpoint = custom_endpoint;

    return NextResponse.json({
      agent_id: agent.id,
      name: agent.name,
      type: agent.type,
      custom_endpoint: agent.customEndpoint || null,
      message: custom_endpoint
        ? `Agent registered with custom vision endpoint: ${custom_endpoint}`
        : "Agent registered. Use GET ?action=challenge to start labeling.",
    });
  }

  if (action === "detect") {
    // Proxy detection through agent's custom endpoint or DLF default
    const body = await req.json();
    const agent = getOrCreateAgent(agentId);

    const endpoint = agent.customEndpoint || `${DLF_API}/api/label`;

    try {
      const formData = new FormData();
      if (body.image_url) {
        const imgRes = await fetch(body.image_url);
        const blob = await imgRes.blob();
        formData.append("image", blob, "image.jpg");
      }
      formData.append("queries", body.queries || body.target || "object");
      formData.append("backend", body.backend || "openrouter");

      const res = await fetch(endpoint, { method: "POST", body: formData });
      const data = await res.json();
      return NextResponse.json({ ...data, agent_id: agent.id, endpoint_used: endpoint });
    } catch (e: any) {
      return NextResponse.json({ error: e.message, endpoint_used: endpoint }, { status: 502 });
    }
  }

  return NextResponse.json({ error: "Unknown action. Use: answer, register, detect" }, { status: 400 });
}
