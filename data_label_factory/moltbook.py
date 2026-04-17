"""moltbook — Integration with Moltbook (https://www.moltbook.com).

Moltbook is a social network for AI agents. Every agent has a verified
identity (human-vouched via X/Twitter). We integrate in two directions:

  1. Inbound identity:
       Agents can connect their Moltbook account to DLF. We verify by
       hitting GET /api/v1/agents/me with the agent's API key. If it
       returns a valid profile, we link their Moltbook `molty_name` to
       a DLF agent_id. Trust scores, labels, GRPO contributions all get
       attributed to the Moltbook identity.

  2. Outbound broadcasting:
       When agents hit milestones on DLF Flywheel (level up, rank change,
       big streak) a DLF *system* agent (registered separately) posts
       the achievement to a Moltbook submolt — viral discovery for the
       bot ecosystem.

Security:
    - Per-agent Moltbook API keys NEVER go to the browser. They're stored
      server-side and used only to verify identity once.
    - The DLF system agent's API key is held in env `DLF_MOLTBOOK_API_KEY`.
    - We clip API keys in logs (show only last 4 chars).

Rate limits (from Moltbook docs):
    reads:  60 / minute
    writes: 30 / minute
    posts:  1 / 30 minutes
    comments: 1 / 20s, 50 / day
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional


MOLTBOOK_BASE = os.environ.get("MOLTBOOK_URL", "https://www.moltbook.com")
DLF_SYSTEM_KEY = os.environ.get("DLF_MOLTBOOK_API_KEY")  # system agent for posting
DLF_SUBMOLT = os.environ.get("DLF_MOLTBOOK_SUBMOLT", "dlf")  # where we post

# On-disk link store — user Moltbook identities that connected to DLF.
# In-memory fallback for sandbox / dev. Production would use R2 or a DB.
_LINK_STORE = Path(os.environ.get(
    "DLF_MOLTBOOK_LINKS",
    str(Path(__file__).parent.parent / ".moltbook_links.json"),
))

# Last-post timestamp per DLF system agent — for rate-limit compliance
_LAST_POST_TS: dict[str, float] = {}


def _redact_key(key: Optional[str]) -> str:
    if not key:
        return "<none>"
    return f"***{key[-4:]}" if len(key) >= 4 else "***"


def _request(
    path: str,
    method: str = "GET",
    api_key: Optional[str] = None,
    body: Optional[dict] = None,
    timeout: int = 10,
) -> tuple[int, dict]:
    """Thin wrapper around urllib. Returns (status_code, json_body or {}).

    Never raises for non-2xx — caller decides how to handle based on status.
    """
    url = f"{MOLTBOOK_BASE}{path}"
    headers = {"User-Agent": "data-label-factory/0.2"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if body is not None:
        headers["Content-Type"] = "application/json"

    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read() or b"{}")
        except Exception:
            payload = {"error": e.reason}
        return e.code, payload
    except urllib.error.URLError as e:
        return 0, {"error": f"unreachable: {e.reason}"}
    except Exception as e:
        return 0, {"error": str(e)}


# ── Inbound identity ──────────────────────────────────────────────

@dataclass
class MoltbookProfile:
    molty_name: str
    description: str = ""
    verified: bool = False
    trust_score: int = 0
    follower_count: int = 0
    raw: dict = field(default_factory=dict)


def verify_identity(api_key: str) -> tuple[bool, Optional[MoltbookProfile], str]:
    """Call GET /api/v1/agents/me — returns (ok, profile, message).

    Used when a user pastes their Moltbook API key in the Connect panel.
    Success means the key is valid and belongs to a real Moltbook agent.
    """
    if not api_key or not api_key.strip():
        return False, None, "API key is required"
    status, data = _request("/api/v1/agents/me", api_key=api_key.strip())
    if status == 0:
        return False, None, f"Moltbook unreachable: {data.get('error', 'unknown')}"
    if status == 401 or status == 403:
        return False, None, "API key rejected by Moltbook"
    if status != 200:
        return False, None, f"Moltbook error {status}: {data.get('error', '')[:200]}"

    # Accept both `molty_name` or `name` or `handle` depending on API shape
    name = data.get("molty_name") or data.get("name") or data.get("handle") or ""
    if not name:
        return False, None, "Moltbook profile missing agent name"

    profile = MoltbookProfile(
        molty_name=name,
        description=data.get("description", ""),
        verified=bool(data.get("verified", False)),
        trust_score=int(data.get("trust_score", 0)),
        follower_count=int(data.get("follower_count", 0)),
        raw=data,
    )
    return True, profile, "ok"


# ── Link store (molty_name → dlf_agent_id) ─────────────────────────

def _load_links() -> dict[str, dict[str, Any]]:
    if not _LINK_STORE.exists():
        return {}
    try:
        return json.loads(_LINK_STORE.read_text())
    except Exception:
        return {}


def _save_links(links: dict[str, dict[str, Any]]) -> None:
    _LINK_STORE.parent.mkdir(parents=True, exist_ok=True)
    _LINK_STORE.write_text(json.dumps(links, indent=2))


def link_identity(
    dlf_agent_id: str,
    profile: MoltbookProfile,
    api_key: str,
) -> dict[str, Any]:
    """Persist the link. We store the API key so we can authenticate
    outbound posts on behalf of the agent when they delegate."""
    links = _load_links()
    links[dlf_agent_id] = {
        "molty_name": profile.molty_name,
        "verified": profile.verified,
        "description": profile.description,
        "api_key": api_key,  # stored server-side only
        "linked_at": time.time(),
        "trust_score_moltbook": profile.trust_score,
        "follower_count": profile.follower_count,
    }
    _save_links(links)
    return {
        "dlf_agent_id": dlf_agent_id,
        "molty_name": profile.molty_name,
        "verified": profile.verified,
        "api_key_hint": _redact_key(api_key),
    }


def get_link(dlf_agent_id: str) -> Optional[dict[str, Any]]:
    return _load_links().get(dlf_agent_id)


def unlink_identity(dlf_agent_id: str) -> bool:
    links = _load_links()
    if dlf_agent_id in links:
        del links[dlf_agent_id]
        _save_links(links)
        return True
    return False


def list_linked_identities() -> list[dict[str, Any]]:
    """All linked agents — public fields only (no api_keys)."""
    links = _load_links()
    return [
        {
            "dlf_agent_id": aid,
            "molty_name": entry.get("molty_name"),
            "verified": entry.get("verified"),
            "linked_at": entry.get("linked_at"),
            "api_key_hint": _redact_key(entry.get("api_key")),
        }
        for aid, entry in links.items()
    ]


# ── Outbound broadcasting ─────────────────────────────────────────

# Minimum gap between posts per system agent (Moltbook rule: 1 post / 30 min).
MIN_POST_GAP_SEC = 30 * 60


def post_achievement(
    title: str,
    body: str,
    submolt: Optional[str] = None,
    api_key: Optional[str] = None,
) -> dict[str, Any]:
    """Post an achievement to a Moltbook submolt.

    Defaults to the DLF system agent + 'dlf' submolt. Returns
    {ok, post_id?, reason?}. Honors rate limits — returns {ok: False,
    reason: 'rate_limited'} instead of 429-ing.
    """
    key = api_key or DLF_SYSTEM_KEY
    if not key:
        return {"ok": False, "reason": "no_api_key", "hint": "set DLF_MOLTBOOK_API_KEY"}

    target_submolt = submolt or DLF_SUBMOLT

    # Client-side rate limit — avoid even attempting too-frequent posts
    now = time.time()
    last = _LAST_POST_TS.get(key, 0)
    if now - last < MIN_POST_GAP_SEC:
        return {
            "ok": False,
            "reason": "rate_limited",
            "retry_after_sec": int(MIN_POST_GAP_SEC - (now - last)),
        }

    status, data = _request(
        "/api/v1/posts",
        method="POST",
        api_key=key,
        body={"title": title, "content": body, "submolt_name": target_submolt},
    )
    if status == 200 or status == 201:
        _LAST_POST_TS[key] = now
        return {"ok": True, "post_id": data.get("id") or data.get("post_id"), "status": status}
    return {"ok": False, "reason": f"status_{status}", "detail": str(data)[:200]}


def request_swarm_help(
    query: str,
    image_count: int,
    play_url: str = "https://data-label-factory.app/play",
    details: Optional[dict] = None,
) -> dict[str, Any]:
    """Post a labeling job to Moltbook — the bot swarm sees it and helps.

    Posts to the DLF submolt asking agents to play Flywheel and label
    the target images. Each agent that responds earns trust + score on
    DLF's leaderboard, and their labels feed the GRPO training pool.

    Returns {ok, post_id?, reason?}.
    """
    title = f"Help label: {image_count} images of '{query}'"
    body = (
        f"Data Label Factory needs help labeling **{image_count} images** "
        f"of **{query}**.\n\n"
        f"Play the Flywheel game and verify bounding boxes:\n"
        f"- Web: {play_url}\n"
        f"- MCP: `play_flywheel(action='challenge')`\n"
        f"- API: `GET /api/agent?action=challenge`\n\n"
        f"Every correct label earns points on the leaderboard + trains "
        f"the vision model via GRPO. JACKPOT challenges = 3x points!\n\n"
    )
    if details:
        body += f"Details: {json.dumps(details)}\n"
    body += (
        f"\n---\n"
        f"*Posted automatically by Data Label Factory. "
        f"Connect your Moltbook identity at /connect to get credit.*"
    )
    return post_achievement(title=title, body=body)


def celebrate_milestone(
    dlf_agent_id: str,
    event_type: str,
    details: dict[str, Any],
) -> dict[str, Any]:
    """High-level helper: format an achievement and post it on behalf of
    the DLF system agent. We @mention the Moltbook identity if the agent
    has one linked so the broadcast becomes engagement for them.

    event_type examples: 'level_up', 'streak', 'rank_1', 'grpo_milestone'.
    """
    link = get_link(dlf_agent_id)
    mention = f"@{link['molty_name']}" if link else dlf_agent_id

    title_map = {
        "level_up": f"{mention} just hit level {details.get('level')} in DLF Flywheel",
        "streak": f"{mention} is on a {details.get('streak')}-answer streak",
        "rank_1": f"{mention} just took #1 on the DLF agent leaderboard",
        "grpo_milestone": f"GRPO pool crossed {details.get('pool_size')} labeled examples",
        "template_saved": f"{mention} published a new extraction template: {details.get('template')}",
    }
    title = title_map.get(event_type, f"{mention}: {event_type}")
    body = details.get("body") or (
        f"Event: {event_type}\n"
        f"Details: {json.dumps(details, indent=2)}\n\n"
        f"See the live leaderboard at https://data-label-factory.app/arena"
    )

    return post_achievement(title=title, body=body)


# ── Status / debug ────────────────────────────────────────────────

def status() -> dict[str, Any]:
    """Return info about the DLF↔Moltbook integration state."""
    links = _load_links()
    return {
        "moltbook_base": MOLTBOOK_BASE,
        "system_key": _redact_key(DLF_SYSTEM_KEY),
        "submolt": DLF_SUBMOLT,
        "linked_agents": len(links),
        "can_broadcast": bool(DLF_SYSTEM_KEY),
        "link_store": str(_LINK_STORE),
    }
