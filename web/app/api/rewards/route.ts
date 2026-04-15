import { NextRequest, NextResponse } from "next/server";

/**
 * Reward Data Collection API — the actual value of Flywheel.
 *
 * Every label from humans and agents is stored here as GRPO training data.
 * Format: { image_url, target, label (YES/NO), reward (+3/-3), source, trust }
 *
 * Endpoints:
 *   POST /api/rewards          — submit a reward data point
 *   GET  /api/rewards          — get collected reward data (for training)
 *   GET  /api/rewards?stats    — aggregate stats
 */

export type RewardEntry = {
  id: string;
  imageUrl: string;
  target: string;
  label: "YES" | "NO";
  reward: number;         // +3 correct, -3 wrong, 0 honeypot-only
  source: string;         // "human:web", "agent:hermes-1", "agent:claude-1"
  sourceType: "human" | "agent";
  trustScore: number;     // player's trust at time of labeling
  isHoneypot: boolean;
  honeypotCorrect?: boolean;
  responseTimeMs: number;
  streak: number;
  timestamp: string;
};

// In-memory store (production: R2 + database)
const rewardPool: RewardEntry[] = [];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const entry: RewardEntry = {
      id: `rw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      imageUrl: body.image_url || body.imageUrl || "",
      target: body.target || "",
      label: (body.label || body.answer || "").toUpperCase() as "YES" | "NO",
      reward: body.reward ?? (body.correct ? 3 : -3),
      source: body.source || "unknown",
      sourceType: body.source_type || body.sourceType || "human",
      trustScore: body.trust_score ?? body.trustScore ?? 100,
      isHoneypot: body.is_honeypot ?? body.isHoneypot ?? false,
      honeypotCorrect: body.honeypot_correct ?? body.honeypotCorrect,
      responseTimeMs: body.response_time_ms ?? body.responseTimeMs ?? 0,
      streak: body.streak ?? 0,
      timestamp: new Date().toISOString(),
    };

    // Only accept labels from trusted sources (trust >= 50)
    if (entry.trustScore < 50) {
      return NextResponse.json({
        accepted: false,
        reason: "Trust score too low. Labels from untrusted sources are discarded.",
        trust_score: entry.trustScore,
      });
    }

    // Don't store honeypot answers as training data (they're for validation only)
    if (entry.isHoneypot) {
      return NextResponse.json({
        accepted: false,
        reason: "Honeypot — used for trust validation, not stored as training data.",
        honeypot_correct: entry.honeypotCorrect,
      });
    }

    rewardPool.push(entry);

    return NextResponse.json({
      accepted: true,
      id: entry.id,
      reward: entry.reward,
      pool_size: rewardPool.length,
      message: `Label accepted. Pool: ${rewardPool.length} entries. Ready for GRPO when >= 500.`,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  // Stats mode
  if (searchParams.has("stats")) {
    const total = rewardPool.length;
    const positive = rewardPool.filter((r) => r.reward > 0).length;
    const negative = rewardPool.filter((r) => r.reward < 0).length;
    const humanLabels = rewardPool.filter((r) => r.sourceType === "human").length;
    const agentLabels = rewardPool.filter((r) => r.sourceType === "agent").length;
    const avgTrust = total > 0 ? Math.round(rewardPool.reduce((s, r) => s + r.trustScore, 0) / total) : 0;
    const avgResponseMs = total > 0 ? Math.round(rewardPool.reduce((s, r) => s + r.responseTimeMs, 0) / total) : 0;
    const uniqueTargets = new Set(rewardPool.map((r) => r.target)).size;
    const uniqueSources = new Set(rewardPool.map((r) => r.source)).size;

    const readyForGRPO = total >= 500;

    return NextResponse.json({
      total,
      positive,
      negative,
      human_labels: humanLabels,
      agent_labels: agentLabels,
      avg_trust: avgTrust,
      avg_response_ms: avgResponseMs,
      unique_targets: uniqueTargets,
      unique_sources: uniqueSources,
      ready_for_grpo: readyForGRPO,
      grpo_progress: `${total}/500 (${Math.round((total / 500) * 100)}%)`,
      reward_distribution: {
        positive_3: rewardPool.filter((r) => r.reward === 3).length,
        negative_3: rewardPool.filter((r) => r.reward === -3).length,
      },
    });
  }

  // Export mode — return all data for GRPO training
  const format = searchParams.get("format") || "json";
  const limit = parseInt(searchParams.get("limit") || "0") || rewardPool.length;

  const data = rewardPool.slice(0, limit);

  if (format === "jsonl") {
    // JSONL format for training pipelines
    const lines = data.map((r) => JSON.stringify({
      image_url: r.imageUrl,
      target: r.target,
      label: r.label,
      reward: r.reward,
      trust: r.trustScore,
    })).join("\n");
    return new Response(lines, {
      headers: { "Content-Type": "application/jsonl", "Content-Disposition": "attachment; filename=rewards.jsonl" },
    });
  }

  return NextResponse.json({
    count: data.length,
    data,
  });
}
