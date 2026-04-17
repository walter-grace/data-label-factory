"""MCP server that bridges any MCP-compatible client (Claude Desktop, agent
frameworks, etc.) to a running data-label-factory agent gateway.

Architecture:

    +-----------+        SSE         +-----------------+
    |  identify | ◀─────────────▶   |   this MCP      |
    |  serve    |  POST /buy        |   server        |
    +-----------+                    +-----------------+
                                              ▲ stdio
                                              │
                                        +-----------+
                                        |  Claude   |
                                        |  Desktop  |
                                        +-----------+

Tools exposed:

    get_manifest()          → discovery doc + event list + endpoints
    list_live_listings()    → snapshot of currently-buyable items
    get_recent_orders(n=25) → last N orders (filled or rejected)
    buy_listing(            → POST a buy intent; returns the order
        listing_id,
        agent_id="claude-desktop",
        max_price_usd=None,
    )
    wait_for_listing(       → block (with timeout) until a listing matching
        label_contains=None,    a label substring appears on the SSE stream;
        max_seconds=30,         lets agents react to "I just held up X" without
    )                           polling.

Run it locally for testing:

    GATEWAY_URL=http://localhost:8500 \
        python -m data_label_factory.identify.mcp_server

In Claude Desktop, register it via claude_desktop_config.json:

    {
      "mcpServers": {
        "card-gateway": {
          "command": "python",
          "args": ["-m", "data_label_factory.identify.mcp_server"],
          "env": {"GATEWAY_URL": "http://localhost:8500"}
        }
      }
    }
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any


GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://localhost:8500").rstrip("/")
DEFAULT_AGENT_ID = os.environ.get("AGENT_ID", "claude-desktop")


def _missing(pkg: str) -> "SystemExit":
    return SystemExit(
        f"missing dependency: {pkg}\n"
        "install with:\n"
        "    pip install 'mcp[cli]' httpx httpx-sse\n"
    )


async def _get_json(client, path: str) -> dict[str, Any]:
    r = await client.get(f"{GATEWAY_URL}{path}")
    r.raise_for_status()
    return r.json()


async def _post_json(client, path: str, body: dict[str, Any]) -> dict[str, Any]:
    r = await client.post(f"{GATEWAY_URL}{path}", json=body)
    # The gateway returns 402 for rejected orders, which is *expected* — we
    # still want to show the order body to the agent rather than raising.
    try:
        return r.json()
    except Exception:
        r.raise_for_status()
        raise


def main() -> int:
    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError:
        raise _missing("mcp")
    try:
        import httpx
    except ImportError:
        raise _missing("httpx")
    try:
        from httpx_sse import aconnect_sse
    except ImportError:
        raise _missing("httpx-sse")

    mcp = FastMCP("card-gateway")

    # One shared async client per process — keepalive matters for SSE.
    client = httpx.AsyncClient(timeout=httpx.Timeout(5.0, read=None))

    @mcp.tool()
    async def get_manifest() -> dict[str, Any]:
        """Fetch the gateway's discovery manifest: endpoints, event names,
        buy-request schema, and operator notes. Call this first to understand
        what the gateway can do."""
        return await _get_json(client, "/.well-known/agent-gateway.json")

    @mcp.tool()
    async def list_live_listings() -> dict[str, Any]:
        """Return all listings currently visible to the camera. Each listing
        has a stable `listing_id` you can pass to `buy_listing`. Listings
        expire automatically when the physical object leaves the frame."""
        return await _get_json(client, "/api/agent/listings")

    @mcp.tool()
    async def get_recent_orders(limit: int = 25) -> dict[str, Any]:
        """Recent orders processed by the gateway (filled or rejected). Useful
        for auditing what other agents have done in this session."""
        limit = max(1, min(int(limit), 200))
        return await _get_json(client, f"/api/agent/orders?limit={limit}")

    @mcp.tool()
    async def buy_listing(
        listing_id: str,
        agent_id: str = DEFAULT_AGENT_ID,
        max_price_usd: float | None = None,
    ) -> dict[str, Any]:
        """Buy a currently-live listing. Returns the order body — check
        `order.status` for "filled" / "rejected_too_expensive" /
        "rejected_no_listing". `max_price_usd` is optional but recommended:
        the gateway will refuse the buy if the listing's price is above it."""
        if not listing_id:
            return {"ok": False, "error": "listing_id required"}
        return await _post_json(client, "/api/agent/buy", {
            "listing_id":    listing_id,
            "agent_id":      agent_id,
            "max_price_usd": max_price_usd,
        })

    @mcp.tool()
    async def wait_for_listing(
        label_contains: str | None = None,
        max_seconds: float = 30.0,
    ) -> dict[str, Any]:
        """Block until a new listing appears on the SSE stream, optionally
        filtered by a case-insensitive substring of its `label`. Returns the
        first matching listing event, or `{"ok": false, "reason": "timeout"}`.
        Use this in agents that want to *react* to objects appearing instead
        of polling."""
        needle = (label_contains or "").lower()
        url = f"{GATEWAY_URL}/api/agent/stream"
        try:
            async with asyncio.timeout(float(max_seconds)):
                async with aconnect_sse(client, "GET", url) as event_source:
                    async for sse in event_source.aiter_sse():
                        if sse.event != "listing.appeared":
                            continue
                        try:
                            data = json.loads(sse.data)
                        except Exception:
                            continue
                        if needle and needle not in str(data.get("label", "")).lower():
                            continue
                        return {"ok": True, "listing": data}
        except asyncio.TimeoutError:
            return {"ok": False, "reason": "timeout", "max_seconds": max_seconds}
        except Exception as e:
            return {"ok": False, "reason": f"stream error: {e}"}
        return {"ok": False, "reason": "stream closed"}

    # MCP servers communicate over stdio when launched by a host like Claude
    # Desktop. FastMCP.run() handles the transport.
    mcp.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
