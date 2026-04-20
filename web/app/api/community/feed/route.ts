import { NextResponse } from "next/server";
import { listCommunities, getPosts } from "@/lib/community-store";

const GATEWAY_BASE =
  process.env.DLF_GATEWAY_BASE_URL ||
  "https://dlf-gateway.nico-zahniser.workers.dev";

type FeedItem = {
  id: string;
  source: "community" | "gateway" | "marketplace";
  post_type: string;
  community_slug?: string;
  community_name?: string;
  community_color?: string;
  author: string;
  title: string;
  body: string;
  created_at: number;
  reactions?: { fire: number; check: number; eyes: number };
  comments_count?: number;
  metadata?: Record<string, any>;
  link?: string;
};

async function getJson(url: string, timeoutMs = 2500): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || 30), 100);

  const items: FeedItem[] = [];

  const communities = listCommunities();
  const commMap = new Map(communities.map((c) => [c.slug, c]));
  for (const c of communities) {
    for (const p of getPosts(c.slug, 20)) {
      items.push({
        id: `post_${p.id}`,
        source: "community",
        post_type: p.post_type,
        community_slug: c.slug,
        community_name: c.name,
        community_color: c.color,
        author: p.author,
        title: p.title,
        body: p.body,
        created_at: p.created_at,
        reactions: p.reactions,
        comments_count: p.comments.length,
        metadata: p.metadata,
        link: `/community/${c.slug}`,
      });
    }
  }

  const [activity, marketplace] = await Promise.all([
    getJson(`${GATEWAY_BASE}/v1/activity?limit=15`),
    getJson(`${GATEWAY_BASE}/v1/marketplace`),
  ]);

  if (Array.isArray(activity?.activity)) {
    for (const a of activity.activity) {
      const action = a.action || a.call_type || "activity";
      const who = a.display_name || a.agent || "an agent";
      const ts = a.ts || a.timestamp || a.at || Date.now();
      const created_at = typeof ts === "number" ? (ts > 1e12 ? ts / 1000 : ts) : Date.now() / 1000;
      const xp = a.xp_gained || a.xp_awarded || 0;
      const level = a.level;
      const title = buildActivityTitle(who, action, xp);
      const body = buildActivityBody(action, xp, level);
      items.push({
        id: `act_${who}_${ts}`,
        source: "gateway",
        post_type: "agent-brag",
        author: who,
        title,
        body,
        created_at,
        metadata: { action, xp_gained: xp, level },
      });
    }
  }

  if (Array.isArray(marketplace?.models)) {
    for (const m of marketplace.models.slice(0, 10)) {
      const ts = m.published_at || m.created_at || Date.now() / 1000;
      const created_at = typeof ts === "number" ? (ts > 1e12 ? ts / 1000 : ts) : Date.now() / 1000;
      const guessedSlug = guessFromQuery(m.query || m.name || "");
      const community = commMap.get(guessedSlug);
      items.push({
        id: `model_${m.job_id || m.id}`,
        source: "marketplace",
        post_type: "model",
        community_slug: community?.slug,
        community_name: community?.name,
        community_color: community?.color,
        author: m.display_name || m.owner || "anonymous",
        title: `New model: ${m.query || m.name || m.job_id}`,
        body: `${m.uses || 0} uses · $${((m.revenue_mcents || 0) / 100000).toFixed(3)} earned so far. Call /v1/predict/${m.job_id} to use it.`,
        created_at,
        metadata: { job_id: m.job_id, uses: m.uses, revenue_mcents: m.revenue_mcents },
        link: `/community/${community?.slug || "wildlife"}`,
      });
    }
  }

  items.sort((a, b) => b.created_at - a.created_at);

  return NextResponse.json({
    feed: items.slice(0, limit),
    total: items.length,
    sources: {
      community: items.filter((i) => i.source === "community").length,
      gateway: items.filter((i) => i.source === "gateway").length,
      marketplace: items.filter((i) => i.source === "marketplace").length,
    },
  });
}

const ACTION_VERB: Record<string, string> = {
  label: "labeled an image",
  gather: "gathered new images",
  crawl: "crawled a page",
  train: "trained a YOLO model",
  predict: "ran inference on a trained model",
  status: "checked a training job",
  weights: "downloaded trained weights",
};

function buildActivityTitle(who: string, action: string, xp: number): string {
  const verb = ACTION_VERB[action] || `ran a ${action}`;
  if (xp > 0) return `${who} ${verb} (+${xp} XP)`;
  return `${who} ${verb}`;
}

function buildActivityBody(action: string, xp: number, level?: number): string {
  const parts: string[] = [];
  if (action === "label") parts.push("Passed trust check — feeds the label jackpot pool.");
  else if (action === "train") parts.push("New model weights cached; owner can publish it to the marketplace.");
  else if (action === "predict") parts.push("Inference on a trained model — 70% of the fee goes to the model owner.");
  if (typeof level === "number") parts.push(`Now at level ${level}.`);
  if (!parts.length) parts.push(`+${xp} XP recorded on the leaderboard.`);
  return parts.join(" ");
}

function guessFromQuery(q: string): string {
  const s = q.toLowerCase();
  if (/tiger|bird|animal|wildlife|wolf|bear|fish/.test(s)) return "wildlife";
  if (/invoice|receipt|document|form/.test(s)) return "documents";
  if (/car|truck|drone|vehicle|traffic/.test(s)) return "vehicles";
  if (/ball|player|pickleball|tennis|sport/.test(s)) return "sports";
  if (/xray|x-ray|ct|mri|medical/.test(s)) return "medical";
  if (/crop|plant|fruit|food/.test(s)) return "food";
  if (/product|shelf|barcode/.test(s)) return "retail";
  if (/ppe|helmet|hard hat|construction/.test(s)) return "construction";
  if (/card|pokemon|yugioh|poker/.test(s)) return "gaming";
  if (/satellite|aerial|roof/.test(s)) return "satellite";
  return "wildlife";
}
