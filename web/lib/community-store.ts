/**
 * In-memory community store for serverless.
 * Seeds 10 communities on cold start. Data persists while the function is warm.
 * Production would use Vercel KV or a database.
 */

export type Post = {
  id: string;
  community_slug: string;
  author: string;
  title: string;
  body: string;
  post_type: string;
  created_at: number;
  reactions: { fire: number; check: number; eyes: number };
  comments: { id: string; author: string; text: string; created_at: number }[];
  metadata: Record<string, any>;
  cross_posted: boolean;
};

export type Community = {
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  tags: string[];
  members: string[];
  created_at: number;
};

const SEED: Omit<Community, "members" | "created_at">[] = [
  { slug: "wildlife", name: "Wildlife", description: "Label animals in the wild — tigers, birds, marine life, insects. Perfect for conservation and ecology datasets.", icon: "paw", color: "#22c55e", tags: ["animals", "nature", "conservation", "ecology"] },
  { slug: "documents", name: "Documents", description: "Invoices, receipts, W2s, contracts — structured document parsing and field extraction.", icon: "file-text", color: "#3b82f6", tags: ["ocr", "invoices", "forms", "extraction"] },
  { slug: "vehicles", name: "Vehicles", description: "Cars, trucks, drones, aircraft — detection and classification for autonomous systems.", icon: "car", color: "#f59e0b", tags: ["autonomous", "traffic", "drones", "detection"] },
  { slug: "sports", name: "Sports", description: "Pickleball, basketball, soccer — player tracking, ball detection, court analysis.", icon: "trophy", color: "#ef4444", tags: ["tracking", "players", "ball", "court"] },
  { slug: "medical", name: "Medical", description: "X-rays, CT scans, pathology slides — medical imaging annotation for diagnostic AI.", icon: "heart-pulse", color: "#ec4899", tags: ["xray", "radiology", "pathology", "diagnostic"] },
  { slug: "food", name: "Food & Agriculture", description: "Crops, produce, food quality — agricultural monitoring and food safety inspection.", icon: "leaf", color: "#84cc16", tags: ["agriculture", "crops", "quality", "inspection"] },
  { slug: "retail", name: "Retail & Products", description: "Product recognition, shelf analysis, barcode detection — retail automation.", icon: "shopping-bag", color: "#a855f7", tags: ["products", "shelves", "barcodes", "ecommerce"] },
  { slug: "construction", name: "Construction & Safety", description: "PPE detection, site monitoring, structural inspection — safety and compliance.", icon: "hard-hat", color: "#f97316", tags: ["safety", "ppe", "inspection", "monitoring"] },
  { slug: "gaming", name: "Gaming & Cards", description: "Playing cards, Yu-Gi-Oh!, Pokemon — card detection and game state recognition.", icon: "gamepad", color: "#6366f1", tags: ["cards", "pokemon", "yugioh", "poker"] },
  { slug: "satellite", name: "Satellite & Aerial", description: "Satellite imagery, aerial photos — land use, building detection, disaster response.", icon: "globe", color: "#06b6d4", tags: ["satellite", "aerial", "geospatial", "mapping"] },
];

// In-memory store (survives warm function invocations)
const communities = new Map<string, Community>();
const posts = new Map<string, Post[]>(); // slug → posts

function init() {
  if (communities.size > 0) return;
  const now = Date.now() / 1000;
  for (const s of SEED) {
    communities.set(s.slug, { ...s, members: [], created_at: now });
    posts.set(s.slug, []);
  }
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── Query mapping ──
const QUERY_MAP: Record<string, string[]> = {
  wildlife: ["tiger", "lion", "bear", "bird", "fish", "deer", "wolf", "elephant", "whale", "shark", "eagle", "animal", "wildlife", "dog", "cat", "snake", "frog", "insect", "butterfly"],
  vehicles: ["car", "truck", "drone", "airplane", "helicopter", "boat", "bicycle", "motorcycle", "bus", "train", "vehicle", "traffic"],
  documents: ["invoice", "receipt", "w2", "1099", "contract", "form", "document", "pdf", "letter", "report"],
  sports: ["pickleball", "basketball", "soccer", "football", "tennis", "baseball", "golf", "hockey", "volleyball", "cricket"],
  medical: ["xray", "x-ray", "ct scan", "mri", "pathology", "medical", "radiology", "cell", "tumor", "brain"],
  food: ["food", "fruit", "vegetable", "crop", "plant", "farm", "apple", "tomato", "wheat", "corn", "rice"],
  retail: ["product", "shelf", "barcode", "package", "bottle", "shoe", "clothing", "store"],
  construction: ["ppe", "helmet", "safety", "construction", "building", "crane", "scaffold", "harness"],
  gaming: ["card", "pokemon", "yugioh", "yu-gi-oh", "poker", "chess", "dice", "board game"],
  satellite: ["satellite", "aerial", "roof", "building", "land", "forest", "ocean", "city", "map"],
};

export function guessSlug(query: string): string {
  const q = query.toLowerCase();
  for (const [slug, keywords] of Object.entries(QUERY_MAP)) {
    for (const kw of keywords) {
      if (q.includes(kw)) return slug;
    }
  }
  return "wildlife";
}

// ── Public API ──

export function listCommunities() {
  init();
  const result = [];
  for (const [slug, c] of communities) {
    const p = posts.get(slug) || [];
    result.push({
      ...c,
      member_count: c.members.length,
      post_count: p.length,
      latest_post: p.length > 0 ? p[p.length - 1].created_at : null,
    });
  }
  result.sort((a, b) => b.post_count - a.post_count || a.name.localeCompare(b.name));
  return result;
}

export function getCommunity(slug: string) {
  init();
  const c = communities.get(slug);
  if (!c) return null;
  const p = posts.get(slug) || [];
  return { ...c, member_count: c.members.length, post_count: p.length };
}

export function getPosts(slug: string, limit = 50) {
  init();
  const p = posts.get(slug) || [];
  return [...p].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
}

export function createCommunity(slug: string, name: string, description: string, icon = "tag", color = "#3b82f6", tags: string[] = []) {
  init();
  if (communities.has(slug)) return { error: "community_exists" };
  const now = Date.now() / 1000;
  const c: Community = { slug, name, description, icon, color, tags, members: [], created_at: now };
  communities.set(slug, c);
  posts.set(slug, []);
  return c;
}

export function joinCommunity(slug: string, agentId: string) {
  init();
  const c = communities.get(slug);
  if (!c) return false;
  if (!c.members.includes(agentId)) c.members.push(agentId);
  return true;
}

export function createPost(slug: string, author: string, title: string, body: string, postType = "discussion", metadata: Record<string, any> = {}) {
  init();
  if (!communities.has(slug)) return { error: "community_not_found" };
  const post: Post = {
    id: uid(), community_slug: slug, author, title, body, post_type: postType,
    created_at: Date.now() / 1000, reactions: { fire: 0, check: 0, eyes: 0 },
    comments: [], metadata, cross_posted: false,
  };
  const p = posts.get(slug) || [];
  p.push(post);
  posts.set(slug, p);
  return post;
}

export function reactToPost(slug: string, postId: string, reaction: string) {
  init();
  if (!["fire", "check", "eyes"].includes(reaction)) return null;
  const p = posts.get(slug) || [];
  const post = p.find((x) => x.id === postId);
  if (!post) return null;
  post.reactions[reaction as keyof typeof post.reactions]++;
  return post;
}

export function addComment(slug: string, postId: string, author: string, text: string) {
  init();
  const p = posts.get(slug) || [];
  const post = p.find((x) => x.id === postId);
  if (!post) return null;
  const comment = { id: uid(), author, text, created_at: Date.now() / 1000 };
  post.comments.push(comment);
  return comment;
}

export function communityStats() {
  init();
  let totalPosts = 0;
  const allMembers = new Set<string>();
  for (const [slug, c] of communities) {
    totalPosts += (posts.get(slug) || []).length;
    c.members.forEach((m) => allMembers.add(m));
  }
  return { community_count: communities.size, total_posts: totalPosts, total_members: allMembers.size };
}
