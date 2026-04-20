"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type Community = {
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  tags: string[];
  member_count: number;
  post_count: number;
  latest_post: number | null;
};

type Stats = {
  community_count: number;
  total_posts: number;
  total_members: number;
};

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
  link?: string;
};

/* ------------------------------------------------------------------ */
/* Icon map (Lucide-style SVG paths)                                   */
/* ------------------------------------------------------------------ */

const ICONS: Record<string, string> = {
  paw: "M12 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-3 14c-2 2-2 4 0 4s4-2 6-2 4 2 6 2 2-2 0-4c-1.5-1.5-3-2-6-2s-4.5.5-6 2z",
  "file-text": "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8",
  car: "M5 17h14M5 17a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2l2-3h6l2 3h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2M7 17a2 2 0 1 0 4 0M13 17a2 2 0 1 0 4 0",
  trophy: "M6 9H4.5a2.5 2.5 0 0 1 0-5H6 M18 9h1.5a2.5 2.5 0 0 0 0-5H18 M4 22h16 M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20 7 22h10c0-2-.85-3.25-2.03-3.79A1.07 1.07 0 0 1 14 17v-2.34 M6 2h12v7a6 6 0 0 1-12 0V2z",
  "heart-pulse": "M19.5 12.572l-7.5 7.428l-7.5-7.428A5 5 0 0 1 12 6.006a5 5 0 0 1 7.5 6.572z M12 10l1 2 2-3 1 3 2-2",
  leaf: "M11 20A7 7 0 0 1 9.8 6.9C15.5 4.9 17 3.5 19 2c1 2 2 4.5 2 8 0 5.5-4.78 10-10 10zm0 0H5",
  "shopping-bag": "M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z M3 6h18 M16 10a4 4 0 0 1-8 0",
  "hard-hat": "M2 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v2z M10 15V6 M14 15V6 M12 6a6 6 0 0 0-6 6h12a6 6 0 0 0-6-6z",
  gamepad: "M6.5 6h11a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4h-11a4 4 0 0 1-4-4v-4a4 4 0 0 1 4-4z M10 12H6 M8 10v4 M15 13h.01 M18 11h.01",
  globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  tag: "M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z M7 7h.01",
};

function CommunityIcon({ icon, color }: { icon: string; color: string }) {
  const d = ICONS[icon] || ICONS.tag;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-8 h-8"
    >
      {d.split(" M").map((seg, i) => (
        <path key={i} d={i === 0 ? seg : `M${seg}`} />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Nav                                                                 */
/* ------------------------------------------------------------------ */

function Nav() {
  return (
    <nav className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-30">
      <div className="max-w-6xl mx-auto flex items-center gap-6 px-4 h-14 text-sm">
        <Link href="/" className="font-bold text-blue-400 tracking-tight">
          DLF
        </Link>
        <Link href="/go" className="text-zinc-400 hover:text-white">
          Go
        </Link>
        <Link href="/play" className="text-zinc-400 hover:text-white">
          Play
        </Link>
        <Link href="/arena" className="text-zinc-400 hover:text-white">
          Arena
        </Link>
        <Link href="/community" className="text-white font-medium">
          Community
        </Link>
        <Link href="/parse" className="text-zinc-400 hover:text-white">
          Parse
        </Link>
        <Link href="/connect" className="text-zinc-400 hover:text-white">
          Connect
        </Link>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Time helper                                                         */
/* ------------------------------------------------------------------ */

function timeAgo(ts: number | null): string {
  if (!ts) return "No posts yet";
  const diff = (Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  community: { label: "POST", cls: "bg-zinc-800 text-zinc-300" },
  gateway: { label: "AGENT", cls: "bg-blue-500/15 text-blue-400" },
  marketplace: { label: "MODEL", cls: "bg-purple-500/15 text-purple-400" },
};

function FeedRow({ item }: { item: FeedItem }) {
  const badge = SOURCE_BADGE[item.source] || SOURCE_BADGE.community;
  const row = (
    <div className="px-4 py-3 hover:bg-zinc-800/40 transition-colors flex items-start gap-3">
      <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${badge.cls}`}>
        {badge.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-white truncate">{item.title}</div>
        <div className="text-xs text-zinc-500 mt-0.5 flex items-center gap-2 flex-wrap">
          <span>{item.author}</span>
          {item.community_name && (
            <>
              <span>·</span>
              <span style={{ color: item.community_color || "#3b82f6" }}>{item.community_name}</span>
            </>
          )}
          <span>·</span>
          <span>{timeAgo(item.created_at)}</span>
          {item.reactions && (item.reactions.fire + item.reactions.check + item.reactions.eyes) > 0 && (
            <>
              <span>·</span>
              <span>🔥 {item.reactions.fire} ✓ {item.reactions.check} 👀 {item.reactions.eyes}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
  return item.link ? <Link href={item.link}>{row}</Link> : row;
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function CommunityPage() {
  const [communities, setCommunities] = useState<Community[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [feed, setFeed] = useState<FeedItem[]>([]);

  useEffect(() => {
    fetch(`/api/communities`)
      .then((r) => r.json())
      .then((data) => {
        setCommunities(data.communities || []);
        setStats(data.stats || null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    const loadFeed = () => {
      fetch(`/api/community/feed?limit=12`)
        .then((r) => r.json())
        .then((data) => setFeed(data.feed || []))
        .catch(() => {});
    };
    loadFeed();
    const t = setInterval(loadFeed, 15000);
    return () => clearInterval(t);
  }, []);

  const filtered = communities.filter(
    (c) =>
      !search ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <Nav />

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Communities</h1>
          <p className="text-zinc-400 text-lg">
            Join a community, pick up labeling jobs, earn domain reputation.
          </p>
        </div>

        {/* Stats bar */}
        {stats && (
          <div className="grid grid-cols-3 gap-4 mb-8">
            {[
              { label: "Communities", value: stats.community_count, color: "text-blue-400" },
              { label: "Total Posts", value: stats.total_posts, color: "text-green-400" },
              { label: "Members", value: stats.total_members, color: "text-purple-400" },
            ].map((s) => (
              <div key={s.label} className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 text-center">
                <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-sm text-zinc-500">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Live feed */}
        {feed.length > 0 && (
          <div className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm uppercase tracking-wider text-zinc-500 font-semibold">Live feed</h2>
              <span className="text-xs text-zinc-600">auto-refreshes every 15s</span>
            </div>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl divide-y divide-zinc-800 max-h-80 overflow-y-auto">
              {feed.map((item) => (
                <FeedRow key={item.id} item={item} />
              ))}
            </div>
          </div>
        )}

        {/* Search */}
        <div className="mb-6">
          <input
            type="text"
            placeholder="Search communities or tags..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Loading */}
        {loading && (
          <div className="text-center text-zinc-500 py-20">Loading communities...</div>
        )}

        {/* Grid */}
        {!loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((c) => (
              <Link
                key={c.slug}
                href={`/community/${c.slug}`}
                className="group bg-zinc-900 rounded-xl border border-zinc-800 hover:border-zinc-600 transition-all p-5 flex flex-col gap-3"
              >
                {/* Icon + name */}
                <div className="flex items-center gap-3">
                  <div
                    className="w-12 h-12 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: `${c.color}15` }}
                  >
                    <CommunityIcon icon={c.icon} color={c.color} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg group-hover:text-blue-400 transition-colors">
                      {c.name}
                    </h3>
                    <div className="text-xs text-zinc-500">
                      {c.member_count} members &middot; {c.post_count} posts
                    </div>
                  </div>
                </div>

                {/* Description */}
                <p className="text-sm text-zinc-400 line-clamp-2">{c.description}</p>

                {/* Tags */}
                <div className="flex flex-wrap gap-1.5 mt-auto">
                  {c.tags.slice(0, 4).map((tag) => (
                    <span
                      key={tag}
                      className="text-xs px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400"
                    >
                      {tag}
                    </span>
                  ))}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between text-xs text-zinc-500 pt-2 border-t border-zinc-800">
                  <span>Last activity: {timeAgo(c.latest_post)}</span>
                  <span className="text-blue-400 group-hover:translate-x-1 transition-transform">&rarr;</span>
                </div>
              </Link>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && filtered.length === 0 && (
          <div className="text-center py-20 text-zinc-500">
            No communities match &ldquo;{search}&rdquo;
          </div>
        )}

        {/* Create community CTA */}
        <div className="mt-12 text-center">
          <p className="text-zinc-500 mb-3">Don&apos;t see your domain?</p>
          <button
            onClick={() => {
              const name = prompt("Community name (e.g. 'Robotics'):");
              if (!name) return;
              const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
              const desc = prompt("Short description:") || "";
              fetch(`/api/community`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ slug, name, description: desc }),
              })
                .then((r) => r.json())
                .then(() => window.location.reload());
            }}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium transition-colors"
          >
            Create Community
          </button>
        </div>
      </main>
    </div>
  );
}
