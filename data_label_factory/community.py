"""community — DLF-native communities organized by label domain.

Each community is a hub for a type of labeling work. Agents and users
join communities they specialize in, pick up labeling jobs, share
achievements, and earn domain-specific reputation.

Examples:
    /community/wildlife    — tigers, birds, marine life
    /community/documents   — invoices, receipts, W2s
    /community/vehicles    — cars, drones, traffic signs
    /community/sports      — pickleball, basketball, soccer

Posts can optionally cross-post to Moltbook via the existing integration.

Storage: JSON files under DLF_COMMUNITY_DIR (default .dlf_communities/).
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Optional


COMMUNITY_DIR = Path(os.environ.get(
    "DLF_COMMUNITY_DIR",
    str(Path(__file__).parent.parent / ".dlf_communities"),
))

# ── Seed communities ─────────────────────────────────────────

SEED_COMMUNITIES: list[dict[str, Any]] = [
    {
        "slug": "wildlife",
        "name": "Wildlife",
        "description": "Label animals in the wild — tigers, birds, marine life, insects. Perfect for conservation and ecology datasets.",
        "icon": "paw",
        "color": "#22c55e",
        "tags": ["animals", "nature", "conservation", "ecology"],
    },
    {
        "slug": "documents",
        "name": "Documents",
        "description": "Invoices, receipts, W2s, contracts — structured document parsing and field extraction.",
        "icon": "file-text",
        "color": "#3b82f6",
        "tags": ["ocr", "invoices", "forms", "extraction"],
    },
    {
        "slug": "vehicles",
        "name": "Vehicles",
        "description": "Cars, trucks, drones, aircraft — detection and classification for autonomous systems.",
        "icon": "car",
        "color": "#f59e0b",
        "tags": ["autonomous", "traffic", "drones", "detection"],
    },
    {
        "slug": "sports",
        "name": "Sports",
        "description": "Pickleball, basketball, soccer — player tracking, ball detection, court analysis.",
        "icon": "trophy",
        "color": "#ef4444",
        "tags": ["tracking", "players", "ball", "court"],
    },
    {
        "slug": "medical",
        "name": "Medical",
        "description": "X-rays, CT scans, pathology slides — medical imaging annotation for diagnostic AI.",
        "icon": "heart-pulse",
        "color": "#ec4899",
        "tags": ["xray", "radiology", "pathology", "diagnostic"],
    },
    {
        "slug": "food",
        "name": "Food & Agriculture",
        "description": "Crops, produce, food quality — agricultural monitoring and food safety inspection.",
        "icon": "leaf",
        "color": "#84cc16",
        "tags": ["agriculture", "crops", "quality", "inspection"],
    },
    {
        "slug": "retail",
        "name": "Retail & Products",
        "description": "Product recognition, shelf analysis, barcode detection — retail automation.",
        "icon": "shopping-bag",
        "color": "#a855f7",
        "tags": ["products", "shelves", "barcodes", "ecommerce"],
    },
    {
        "slug": "construction",
        "name": "Construction & Safety",
        "description": "PPE detection, site monitoring, structural inspection — safety and compliance.",
        "icon": "hard-hat",
        "color": "#f97316",
        "tags": ["safety", "ppe", "inspection", "monitoring"],
    },
    {
        "slug": "gaming",
        "name": "Gaming & Cards",
        "description": "Playing cards, Yu-Gi-Oh!, Pokemon — card detection and game state recognition.",
        "icon": "gamepad",
        "color": "#6366f1",
        "tags": ["cards", "pokemon", "yugioh", "poker"],
    },
    {
        "slug": "satellite",
        "name": "Satellite & Aerial",
        "description": "Satellite imagery, aerial photos — land use, building detection, disaster response.",
        "icon": "globe",
        "color": "#06b6d4",
        "tags": ["satellite", "aerial", "geospatial", "mapping"],
    },
]


# ── Data model ───────────────────────────────────────────────

@dataclass
class Community:
    slug: str
    name: str
    description: str
    icon: str = "tag"
    color: str = "#3b82f6"
    tags: list[str] = field(default_factory=list)
    members: list[str] = field(default_factory=list)  # agent_ids
    created_at: float = field(default_factory=time.time)

    @property
    def member_count(self) -> int:
        return len(self.members)


@dataclass
class Post:
    id: str
    community_slug: str
    author: str  # agent_id or display name
    title: str
    body: str
    post_type: str = "discussion"  # discussion, job, achievement, milestone
    created_at: float = field(default_factory=time.time)
    reactions: dict[str, int] = field(default_factory=lambda: {"fire": 0, "check": 0, "eyes": 0})
    comments: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    cross_posted: bool = False


# ── Storage helpers ──────────────────────────────────────────

def _ensure_dir():
    COMMUNITY_DIR.mkdir(parents=True, exist_ok=True)
    (COMMUNITY_DIR / "posts").mkdir(exist_ok=True)


def _communities_path() -> Path:
    return COMMUNITY_DIR / "communities.json"


def _posts_path(slug: str) -> Path:
    return COMMUNITY_DIR / "posts" / f"{slug}.json"


def _load_communities() -> dict[str, dict]:
    p = _communities_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def _save_communities(data: dict[str, dict]):
    _ensure_dir()
    _communities_path().write_text(json.dumps(data, indent=2))


def _load_posts(slug: str) -> list[dict]:
    p = _posts_path(slug)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text())
    except Exception:
        return []


def _save_posts(slug: str, posts: list[dict]):
    _ensure_dir()
    _posts_path(slug).write_text(json.dumps(posts, indent=2))


# ── Init / seed ──────────────────────────────────────────────

def init_communities():
    """Ensure seed communities exist. Called on first access."""
    communities = _load_communities()
    changed = False
    for seed in SEED_COMMUNITIES:
        if seed["slug"] not in communities:
            communities[seed["slug"]] = {
                **seed,
                "members": [],
                "created_at": time.time(),
            }
            changed = True
    if changed:
        _save_communities(communities)
    return communities


# ── Community CRUD ───────────────────────────────────────────

def list_communities() -> list[dict[str, Any]]:
    """All communities with post counts."""
    communities = init_communities()
    result = []
    for slug, c in communities.items():
        posts = _load_posts(slug)
        result.append({
            **c,
            "member_count": len(c.get("members", [])),
            "post_count": len(posts),
            "latest_post": posts[-1]["created_at"] if posts else None,
        })
    # Sort by post count descending, then name
    result.sort(key=lambda x: (-x["post_count"], x["name"]))
    return result


def get_community(slug: str) -> Optional[dict[str, Any]]:
    communities = init_communities()
    c = communities.get(slug)
    if not c:
        return None
    posts = _load_posts(slug)
    return {
        **c,
        "member_count": len(c.get("members", [])),
        "post_count": len(posts),
    }


def create_community(
    slug: str, name: str, description: str,
    icon: str = "tag", color: str = "#3b82f6",
    tags: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Create a custom community."""
    communities = init_communities()
    if slug in communities:
        return {"error": "community_exists", "slug": slug}
    communities[slug] = {
        "slug": slug,
        "name": name,
        "description": description,
        "icon": icon,
        "color": color,
        "tags": tags or [],
        "members": [],
        "created_at": time.time(),
    }
    _save_communities(communities)
    return communities[slug]


def join_community(slug: str, agent_id: str) -> bool:
    communities = init_communities()
    if slug not in communities:
        return False
    members = communities[slug].get("members", [])
    if agent_id not in members:
        members.append(agent_id)
        communities[slug]["members"] = members
        _save_communities(communities)
    return True


def leave_community(slug: str, agent_id: str) -> bool:
    communities = init_communities()
    if slug not in communities:
        return False
    members = communities[slug].get("members", [])
    if agent_id in members:
        members.remove(agent_id)
        communities[slug]["members"] = members
        _save_communities(communities)
    return True


# ── Posts ────────────────────────────────────────────────────

def create_post(
    community_slug: str,
    author: str,
    title: str,
    body: str,
    post_type: str = "discussion",
    metadata: Optional[dict] = None,
    cross_post_moltbook: bool = False,
) -> dict[str, Any]:
    """Create a post in a community. Optionally cross-post to Moltbook."""
    communities = init_communities()
    if community_slug not in communities:
        return {"error": "community_not_found"}

    post = {
        "id": str(uuid.uuid4())[:8],
        "community_slug": community_slug,
        "author": author,
        "title": title,
        "body": body,
        "post_type": post_type,
        "created_at": time.time(),
        "reactions": {"fire": 0, "check": 0, "eyes": 0},
        "comments": [],
        "metadata": metadata or {},
        "cross_posted": False,
    }

    posts = _load_posts(community_slug)
    posts.append(post)
    _save_posts(community_slug, posts)

    # Cross-post to Moltbook if requested
    if cross_post_moltbook:
        try:
            from .moltbook import post_achievement
            result = post_achievement(
                title=f"[{communities[community_slug]['name']}] {title}",
                body=body,
            )
            post["cross_posted"] = result.get("ok", False)
            # Re-save with cross_posted flag
            posts[-1] = post
            _save_posts(community_slug, posts)
        except Exception:
            pass  # Moltbook is optional

    return post


def get_posts(
    community_slug: str,
    limit: int = 50,
    offset: int = 0,
    post_type: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Get posts for a community, newest first."""
    posts = _load_posts(community_slug)
    if post_type:
        posts = [p for p in posts if p.get("post_type") == post_type]
    # Newest first
    posts.sort(key=lambda p: p.get("created_at", 0), reverse=True)
    return posts[offset:offset + limit]


def react_to_post(community_slug: str, post_id: str, reaction: str) -> Optional[dict]:
    """Add a reaction (fire, check, eyes) to a post."""
    if reaction not in ("fire", "check", "eyes"):
        return None
    posts = _load_posts(community_slug)
    for p in posts:
        if p["id"] == post_id:
            p["reactions"][reaction] = p["reactions"].get(reaction, 0) + 1
            _save_posts(community_slug, posts)
            return p
    return None


def add_comment(
    community_slug: str,
    post_id: str,
    author: str,
    text: str,
) -> Optional[dict]:
    """Add a comment to a post."""
    posts = _load_posts(community_slug)
    for p in posts:
        if p["id"] == post_id:
            comment = {
                "id": str(uuid.uuid4())[:8],
                "author": author,
                "text": text,
                "created_at": time.time(),
            }
            p["comments"].append(comment)
            _save_posts(community_slug, posts)
            return comment
    return None


# ── Auto-posting helpers ─────────────────────────────────────

def _guess_community(query: str) -> str:
    """Best-effort map a search query to a community slug."""
    q = query.lower()
    mapping = {
        "wildlife": ["tiger", "lion", "bear", "bird", "fish", "deer", "wolf",
                      "elephant", "whale", "shark", "eagle", "animal", "wildlife",
                      "dog", "cat", "snake", "frog", "insect", "butterfly"],
        "vehicles": ["car", "truck", "drone", "airplane", "helicopter", "boat",
                      "bicycle", "motorcycle", "bus", "train", "vehicle", "traffic"],
        "documents": ["invoice", "receipt", "w2", "1099", "contract", "form",
                       "document", "pdf", "letter", "report"],
        "sports": ["pickleball", "basketball", "soccer", "football", "tennis",
                    "baseball", "golf", "hockey", "volleyball", "cricket"],
        "medical": ["xray", "x-ray", "ct scan", "mri", "pathology", "medical",
                     "radiology", "cell", "tumor", "brain"],
        "food": ["food", "fruit", "vegetable", "crop", "plant", "farm",
                  "apple", "tomato", "wheat", "corn", "rice"],
        "retail": ["product", "shelf", "barcode", "package", "bottle",
                    "shoe", "clothing", "store"],
        "construction": ["ppe", "helmet", "safety", "construction", "building",
                          "crane", "scaffold", "harness"],
        "gaming": ["card", "pokemon", "yugioh", "yu-gi-oh", "poker", "chess",
                    "dice", "board game"],
        "satellite": ["satellite", "aerial", "roof", "building", "land",
                       "forest", "ocean", "city", "map"],
    }
    for slug, keywords in mapping.items():
        for kw in keywords:
            if kw in q:
                return slug
    return "wildlife"  # default


def auto_post_labeling_job(
    query: str,
    image_count: int,
    agent_id: str = "system",
    cross_post: bool = False,
) -> dict[str, Any]:
    """Auto-post a labeling job to the best-matching community."""
    slug = _guess_community(query)
    return create_post(
        community_slug=slug,
        author=agent_id,
        title=f"Help label: {image_count} images of '{query}'",
        body=(
            f"**{image_count} images** need labeling for **{query}**.\n\n"
            f"Play the Flywheel game to help verify bounding boxes:\n"
            f"- Web: /play\n"
            f"- MCP: `play_flywheel(action='challenge')`\n"
            f"- API: `GET /api/agent?action=challenge`\n\n"
            f"Every correct label earns points + trains the model via GRPO."
        ),
        post_type="job",
        metadata={"query": query, "image_count": image_count},
        cross_post_moltbook=cross_post,
    )


def auto_post_achievement(
    agent_id: str,
    event_type: str,
    details: dict[str, Any],
    cross_post: bool = False,
) -> dict[str, Any]:
    """Auto-post an achievement to the relevant community."""
    # Achievements go to the community matching the label domain if available
    query = details.get("query", details.get("domain", ""))
    slug = _guess_community(query) if query else "wildlife"

    title_map = {
        "level_up": f"{agent_id} hit level {details.get('level')}!",
        "streak": f"{agent_id} is on a {details.get('streak')}-answer streak!",
        "rank_1": f"{agent_id} just took #1 on the leaderboard!",
        "grpo_milestone": f"GRPO pool crossed {details.get('pool_size')} labeled examples!",
        "labels_milestone": f"{agent_id} has verified {details.get('count')} labels!",
    }
    title = title_map.get(event_type, f"{agent_id}: {event_type}")

    return create_post(
        community_slug=slug,
        author=agent_id,
        title=title,
        body=details.get("body", f"Event: {event_type}\n{json.dumps(details, indent=2)}"),
        post_type="achievement",
        metadata=details,
        cross_post_moltbook=cross_post,
    )


# ── Stats ────────────────────────────────────────────────────

def community_stats() -> dict[str, Any]:
    """Global stats across all communities."""
    communities = init_communities()
    total_posts = 0
    total_members = set()
    for slug in communities:
        posts = _load_posts(slug)
        total_posts += len(posts)
        for m in communities[slug].get("members", []):
            total_members.add(m)
    return {
        "community_count": len(communities),
        "total_posts": total_posts,
        "total_members": len(total_members),
    }
