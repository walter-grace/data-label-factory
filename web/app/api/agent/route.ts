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

type PendingImageChallenge = {
  kind: "image";
  id: string;
  imageUrl: string;
  target: string;
  isHoneypot: boolean;
  groundTruth?: "YES" | "NO";
  issuedAt: number;
};

type PendingDocChallenge = {
  kind: "doc";
  id: string;
  docId: string;
  blockText: string;
  pageImageUrl: string;
  bbox: number[];
  questionField: string;       // e.g. "header" / "table"
  tentativeType: string;
  isHoneypot: boolean;
  groundTruth?: "YES" | "NO";
  issuedAt: number;
};

type PendingChallenge = PendingImageChallenge | PendingDocChallenge;

const agents = new Map<string, Agent>();
const pendingChallenges = new Map<string, PendingChallenge>();

// Sample challenge pool
const CHALLENGE_POOL = [
  // Honeypots — known ground truth
  { imageUrl: "https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=400", target: "car", isHoneypot: true, groundTruth: "YES" as const },         // car → YES
  { imageUrl: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400", target: "car", isHoneypot: true, groundTruth: "NO" as const },           // mountain → NO
  { imageUrl: "https://images.unsplash.com/photo-1517849845537-4d257902454a?w=400", target: "dog", isHoneypot: true, groundTruth: "YES" as const },          // dog → YES
  { imageUrl: "https://images.unsplash.com/photo-1526336024174-e58f5cdd8e13?w=400", target: "dog", isHoneypot: true, groundTruth: "NO" as const },           // cat → NO
  // Real challenges
  { imageUrl: "https://images.unsplash.com/photo-1543466835-00a7907e9de1?w=400", target: "dog", isHoneypot: false },
  { imageUrl: "https://images.unsplash.com/photo-1583337130417-13104dec14a4?w=400", target: "cat", isHoneypot: false },
  { imageUrl: "https://images.unsplash.com/photo-1474511320723-9a56873571b7?w=400", target: "bird", isHoneypot: false },
  { imageUrl: "https://images.unsplash.com/photo-1566933293069-b55c7f326dd4?w=400", target: "car", isHoneypot: false },
  { imageUrl: "https://images.unsplash.com/photo-1501594907352-04cda38ebc29?w=400", target: "fire hydrant", isHoneypot: false },
  { imageUrl: "https://images.unsplash.com/photo-1518791841217-8f162f1e1131?w=400", target: "cat", isHoneypot: false },
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
      kind: "image",
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

  if (action === "doc-challenge") {
    // Fetch from DLF backend — gives us block_text + bbox + page_image_url
    // plus (internally) ground_truth for honeypots. We strip ground_truth
    // before returning it to the agent.
    try {
      const upstream = await fetch(
        `${DLF_API}/api/doc-challenge?agent_id=${encodeURIComponent(agentId)}`,
        { cache: "no-store" },
      );
      const data = await upstream.json();
      if (!upstream.ok) {
        return NextResponse.json(
          { error: data.detail || data.error || "upstream failed" },
          { status: upstream.status },
        );
      }

      // Resolve the ground truth for this challenge from DLF's /api/doc-challenges
      // (side-channel lookup so we can grade honeypots).
      let groundTruth: "YES" | "NO" | undefined;
      let isHoneypot = false;
      try {
        const allRes = await fetch(`${DLF_API}/api/doc-challenges?limit=200`, { cache: "no-store" });
        if (allRes.ok) {
          const all = await allRes.json();
          // DLF's internal pool isn't exposed via to_public, so we fetch the module directly.
        }
      } catch {}
      // Use a dedicated internal endpoint to get ground truth (see below).
      try {
        const gt = await fetch(`${DLF_API}/api/doc-truth/${encodeURIComponent(data.challenge_id)}`);
        if (gt.ok) {
          const gtd = await gt.json();
          groundTruth = gtd.ground_truth ?? undefined;
          isHoneypot = gtd.is_honeypot ?? false;
        }
      } catch {}

      // Make the page URL absolute so the browser (different origin) can load it.
      const pageImageUrl = data.page_image_url?.startsWith("http")
        ? data.page_image_url
        : `${DLF_API}${data.page_image_url}`;

      pendingChallenges.set(data.challenge_id, {
        kind: "doc",
        id: data.challenge_id,
        docId: data.doc_id,
        blockText: data.block_text,
        pageImageUrl,
        bbox: data.bbox,
        questionField: data.question_field,
        tentativeType: data.tentative_type,
        isHoneypot,
        groundTruth,
        issuedAt: Date.now(),
      });

      return NextResponse.json({
        challenge_id: data.challenge_id,
        kind: "doc",
        doc_id: data.doc_id,
        block_text: data.block_text,
        page_image_url: pageImageUrl,
        bbox: data.bbox,
        page_width: data.page_width,
        page_height: data.page_height,
        question: data.question,
        question_field: data.question_field,
        tentative_type: data.tentative_type,
      });
    } catch (e: any) {
      return NextResponse.json(
        { error: `doc-challenge upstream unreachable: ${e.message}`, dlf: DLF_API },
        { status: 502 },
      );
    }
  }

  if (action === "doc-docs") {
    // Passthrough — lets agents discover what documents are available.
    try {
      const r = await fetch(`${DLF_API}/api/doc-docs`);
      return NextResponse.json(await r.json(), { status: r.status });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
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

  return NextResponse.json(
    {
      error:
        "Unknown action. GET: challenge, doc-challenge, doc-docs, stats, leaderboard. " +
        "POST: answer, doc-answer, register, detect.",
    },
    { status: 400 },
  );
}

export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  const agentId = req.headers.get("x-agent-id") || "anonymous";

  // `answer` and `doc-answer` share the same scoring / trust / reward logic —
  // we route by either action name or by the challenge's stored `kind`, so
  // agents can use a single endpoint if they prefer.
  if (action === "answer" || action === "doc-answer") {
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
    if (userAnswer !== "YES" && userAnswer !== "NO") {
      return NextResponse.json({ error: "answer must be YES or NO" }, { status: 400 });
    }

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

    // Build the reward payload based on challenge kind. Image challenges
    // keep their original shape for back-compat with /api/rewards; doc
    // challenges carry block_text + question_field + doc_id so training
    // can disambiguate modalities.
    let rewardPayload: Record<string, any>;
    if (challenge.kind === "image") {
      rewardPayload = {
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
    } else {
      // doc challenge
      rewardPayload = {
        image_url: challenge.pageImageUrl,   // rendered page (for training)
        target: challenge.questionField,      // e.g. "header"
        label: userAnswer,
        reward: correct ? 3 : -3,
        source: `agent:${agentId}`,
        source_type: "doc",
        doc_id: challenge.docId,
        block_text: challenge.blockText,
        bbox: challenge.bbox,
        tentative_type: challenge.tentativeType,
        trust_score: agent.trustScore,
        is_honeypot: wasHoneypot,
        honeypot_correct: wasHoneypot ? correct : undefined,
        response_time_ms: Date.now() - challenge.issuedAt,
        streak: agent.correctLabels,
      };
    }

    // Fire and forget — don't block the response
    try {
      fetch(`${req.nextUrl.origin}/api/rewards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rewardPayload),
      }).catch(() => {});
    } catch {}

    return NextResponse.json({
      challenge_kind: challenge.kind,
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

  return NextResponse.json(
    { error: "Unknown POST action. Use: answer, doc-answer, register, detect." },
    { status: 400 },
  );
}
