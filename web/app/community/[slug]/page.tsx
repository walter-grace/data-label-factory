"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

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
  members: string[];
  member_count: number;
  post_count: number;
};

type Comment = {
  id: string;
  author: string;
  text: string;
  created_at: number;
};

type Post = {
  id: string;
  community_slug: string;
  author: string;
  title: string;
  body: string;
  post_type: string;
  created_at: number;
  reactions: { fire: number; check: number; eyes: number };
  comments: Comment[];
  metadata: Record<string, any>;
  cross_posted: boolean;
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function timeAgo(ts: number): string {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const TYPE_BADGES: Record<string, { label: string; color: string }> = {
  job: { label: "LABELING JOB", color: "bg-green-500/20 text-green-400 border-green-500/30" },
  achievement: { label: "ACHIEVEMENT", color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
  milestone: { label: "MILESTONE", color: "bg-purple-500/20 text-purple-400 border-purple-500/30" },
  discussion: { label: "DISCUSSION", color: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
};

const REACTIONS = [
  { key: "fire", emoji: "\uD83D\uDD25" },
  { key: "check", emoji: "\u2705" },
  { key: "eyes", emoji: "\uD83D\uDC40" },
] as const;

/* ------------------------------------------------------------------ */
/* Nav                                                                 */
/* ------------------------------------------------------------------ */

function Nav({ communityName }: { communityName: string }) {
  return (
    <nav className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-30">
      <div className="max-w-4xl mx-auto flex items-center gap-6 px-4 h-14 text-sm">
        <Link href="/" className="font-bold text-blue-400 tracking-tight">
          DLF
        </Link>
        <Link href="/community" className="text-zinc-400 hover:text-white">
          Communities
        </Link>
        <span className="text-zinc-600">/</span>
        <span className="text-white font-medium">{communityName}</span>
        <div className="flex-1" />
        <Link href="/go" className="text-zinc-400 hover:text-white">
          Go
        </Link>
        <Link href="/play" className="text-zinc-400 hover:text-white">
          Play
        </Link>
        <Link href="/arena" className="text-zinc-400 hover:text-white">
          Arena
        </Link>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Post card                                                           */
/* ------------------------------------------------------------------ */

function PostCard({
  post,
  onReact,
  onComment,
}: {
  post: Post;
  onReact: (postId: string, reaction: string) => void;
  onComment: (postId: string, text: string) => void;
}) {
  const [showComments, setShowComments] = useState(false);
  const [commentText, setCommentText] = useState("");
  const badge = TYPE_BADGES[post.post_type] || TYPE_BADGES.discussion;

  return (
    <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-5">
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center text-sm font-bold">
          {post.author[0]?.toUpperCase() || "?"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{post.author}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badge.color}`}>
              {badge.label}
            </span>
            {post.cross_posted && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-600 text-zinc-400">
                Moltbook
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500">{timeAgo(post.created_at)}</div>
        </div>
      </div>

      {/* Title + body */}
      <h3 className="font-semibold text-lg mb-2">{post.title}</h3>
      <div className="text-sm text-zinc-300 whitespace-pre-wrap mb-4">
        {post.body}
      </div>

      {/* Job metadata */}
      {post.post_type === "job" && post.metadata?.image_count && (
        <div className="bg-zinc-800 rounded-lg p-3 mb-4 flex items-center gap-4 text-sm">
          <span className="text-green-400 font-mono font-bold">
            {String(post.metadata.image_count)} images
          </span>
          <span className="text-zinc-400">need labeling</span>
          <Link
            href="/play"
            className="ml-auto text-blue-400 hover:text-blue-300 font-medium"
          >
            Play Flywheel &rarr;
          </Link>
        </div>
      )}

      {/* Reactions */}
      <div className="flex items-center gap-2 mb-3">
        {REACTIONS.map((r) => (
          <button
            key={r.key}
            onClick={() => onReact(post.id, r.key)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm transition-colors"
          >
            <span>{r.emoji}</span>
            <span className="text-zinc-400">
              {post.reactions[r.key as keyof typeof post.reactions] || 0}
            </span>
          </button>
        ))}
        <button
          onClick={() => setShowComments(!showComments)}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm transition-colors ml-auto"
        >
          <span className="text-zinc-400">
            {post.comments.length} {post.comments.length === 1 ? "comment" : "comments"}
          </span>
        </button>
      </div>

      {/* Comments */}
      {showComments && (
        <div className="border-t border-zinc-800 pt-3 mt-3 space-y-3">
          {post.comments.map((c) => (
            <div key={c.id} className="flex gap-2 text-sm">
              <div className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center text-[10px] font-bold shrink-0">
                {c.author[0]?.toUpperCase() || "?"}
              </div>
              <div>
                <span className="font-medium text-zinc-300">{c.author}</span>
                <span className="text-zinc-500 ml-2 text-xs">{timeAgo(c.created_at)}</span>
                <p className="text-zinc-400 mt-0.5">{c.text}</p>
              </div>
            </div>
          ))}

          {/* Comment input */}
          <div className="flex gap-2 mt-2">
            <input
              type="text"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && commentText.trim()) {
                  onComment(post.id, commentText.trim());
                  setCommentText("");
                }
              }}
              placeholder="Add a comment..."
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={() => {
                if (commentText.trim()) {
                  onComment(post.id, commentText.trim());
                  setCommentText("");
                }
              }}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition-colors"
            >
              Post
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* New Post form                                                       */
/* ------------------------------------------------------------------ */

function NewPostForm({
  slug,
  onPost,
}: {
  slug: string;
  onPost: (post: Post) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [postType, setPostType] = useState("discussion");
  const [crossPost, setCrossPost] = useState(false);
  const [posting, setPosting] = useState(false);

  const _proxy = (p: string) => p;

  const submit = async () => {
    if (!title.trim()) return;
    setPosting(true);
    try {
      const res = await fetch(_proxy(`/api/community/${slug}/post`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          author: "you",
          title: title.trim(),
          body: body.trim(),
          post_type: postType,
          cross_post_moltbook: crossPost,
        }),
      });
      const data = await res.json();
      if (data.id) {
        onPost(data);
        setTitle("");
        setBody("");
        setOpen(false);
      }
    } catch {
      // ignore
    } finally {
      setPosting(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded-xl p-4 text-left text-zinc-500 transition-colors"
      >
        Create a post...
      </button>
    );
  }

  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-5 space-y-3">
      {/* Type selector */}
      <div className="flex gap-2">
        {(["discussion", "job", "achievement"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setPostType(t)}
            className={`px-3 py-1 rounded-lg text-sm font-medium transition-colors ${
              postType === t
                ? "bg-blue-600 text-white"
                : "bg-zinc-800 text-zinc-400 hover:text-white"
            }`}
          >
            {t === "job" ? "Labeling Job" : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Post title..."
        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write something..."
        rows={4}
        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500 resize-none"
      />

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
          <input
            type="checkbox"
            checked={crossPost}
            onChange={(e) => setCrossPost(e.target.checked)}
            className="rounded bg-zinc-800 border-zinc-600"
          />
          Cross-post to Moltbook
        </label>
        <div className="flex gap-2">
          <button
            onClick={() => setOpen(false)}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={posting || !title.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            {posting ? "Posting..." : "Post"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function CommunityFeedPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [community, setCommunity] = useState<Community | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [joined, setJoined] = useState(false);

  const _proxy = (p: string) => p;

  const load = useCallback(async () => {
    try {
      const res = await fetch(_proxy(`/api/community/${slug}`));
      const data = await res.json();
      setCommunity(data.community);
      setPosts(data.posts || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  const handleReact = async (postId: string, reaction: string) => {
    try {
      await fetch(_proxy(`/api/community/${slug}/post/${postId}/react`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reaction }),
      });
      // Optimistic update
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId
            ? { ...p, reactions: { ...p.reactions, [reaction]: (p.reactions[reaction as keyof typeof p.reactions] || 0) + 1 } }
            : p
        )
      );
    } catch {
      // ignore
    }
  };

  const handleComment = async (postId: string, text: string) => {
    try {
      const res = await fetch(_proxy(`/api/community/${slug}/post/${postId}/comment`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: "you", text }),
      });
      const comment = await res.json();
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId ? { ...p, comments: [...p.comments, comment] } : p
        )
      );
    } catch {
      // ignore
    }
  };

  const handleJoin = async () => {
    try {
      await fetch(_proxy(`/api/community/${slug}/join`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "you" }),
      });
      setJoined(true);
      if (community) {
        setCommunity({ ...community, member_count: community.member_count + 1 });
      }
    } catch {
      // ignore
    }
  };

  const handleNewPost = (post: Post) => {
    setPosts((prev) => [post, ...prev]);
  };

  const filtered = filter === "all" ? posts : posts.filter((p) => p.post_type === filter);

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white">
        <Nav communityName="..." />
        <div className="text-center text-zinc-500 py-20">Loading...</div>
      </div>
    );
  }

  if (!community) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white">
        <Nav communityName="Not Found" />
        <div className="text-center py-20">
          <h2 className="text-2xl font-bold mb-2">Community not found</h2>
          <Link href="/community" className="text-blue-400">
            &larr; Back to communities
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <Nav communityName={community.name} />

      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* Community header */}
        <div
          className="rounded-xl border border-zinc-800 p-6 mb-6"
          style={{ background: `linear-gradient(135deg, ${community.color}10, transparent)` }}
        >
          <div className="flex items-start justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold mb-1">{community.name}</h1>
              <p className="text-zinc-400">{community.description}</p>
            </div>
            <button
              onClick={handleJoin}
              disabled={joined}
              className={`px-5 py-2 rounded-lg font-medium text-sm transition-colors ${
                joined
                  ? "bg-zinc-700 text-zinc-400 cursor-default"
                  : "bg-blue-600 hover:bg-blue-500 text-white"
              }`}
            >
              {joined ? "Joined" : "Join"}
            </button>
          </div>

          <div className="flex items-center gap-6 text-sm text-zinc-400">
            <span>
              <strong className="text-white">{community.member_count}</strong> members
            </span>
            <span>
              <strong className="text-white">{community.post_count}</strong> posts
            </span>
            <div className="flex gap-1.5">
              {community.tags.map((tag) => (
                <span key={tag} className="px-2 py-0.5 rounded-full bg-zinc-800 text-xs">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* New post */}
        <div className="mb-6">
          <NewPostForm slug={slug} onPost={handleNewPost} />
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2 mb-6">
          {["all", "discussion", "job", "achievement"].map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filter === t
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t === "all" ? "All" : t === "job" ? "Jobs" : t.charAt(0).toUpperCase() + t.slice(1) + "s"}
            </button>
          ))}
        </div>

        {/* Posts */}
        <div className="space-y-4">
          {filtered.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              onReact={handleReact}
              onComment={handleComment}
            />
          ))}
        </div>

        {/* Empty state */}
        {filtered.length === 0 && (
          <div className="text-center py-16 text-zinc-500">
            <p className="text-lg mb-2">No posts yet</p>
            <p className="text-sm">Be the first to post in {community.name}!</p>
          </div>
        )}

        {/* Quick links */}
        <div className="mt-12 grid grid-cols-2 gap-4">
          <Link
            href="/play"
            className="bg-zinc-900 border border-zinc-800 hover:border-green-500/30 rounded-xl p-4 text-center transition-colors"
          >
            <div className="text-2xl mb-1">&#127922;</div>
            <div className="font-medium">Play Flywheel</div>
            <div className="text-xs text-zinc-500">Earn points labeling</div>
          </Link>
          <Link
            href="/go"
            className="bg-zinc-900 border border-zinc-800 hover:border-blue-500/30 rounded-xl p-4 text-center transition-colors"
          >
            <div className="text-2xl mb-1">&#128640;</div>
            <div className="font-medium">Label Data</div>
            <div className="text-xs text-zinc-500">Start a labeling job</div>
          </Link>
        </div>
      </main>
    </div>
  );
}
