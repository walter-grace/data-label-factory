"""Agent gateway: SSE event bus that lets autonomous agents (MCP clients,
LLM agents, scripts) react in real time to objects being held in front of
the camera and buy them while they're visible.

Architecture:

    serve.py /api/falcon  ──publish()──▶  AgentGateway
                                          │  ├─ in-memory listings store
                                          │  └─ event bus (asyncio queues)
                                          ▼
                          GET /api/agent/stream  (text/event-stream)
                                          │
                                          ▼
                          MCP server  →  agent  →  POST /api/agent/buy

Event types emitted on the SSE stream:

    listing.appeared   — first time a (label, ref) was seen this session
    listing.expired    — not seen for `ttl_s`; no longer buyable
    listing.price      — price changed mid-stream
    order.filled       — an agent successfully bought a listing
    order.rejected     — buy attempt rejected (expired / over budget)
    heartbeat          — every 15s, so agents can detect dead connections

Each event is one SSE frame:
    event: listing.appeared
    data:  {"listing_id":"lst_…","label":"Number 65 Djinn Buster", …}

The store and the bus live together because every state change *is* the
event — there's no separate persistence layer. For a real deployment, swap
the in-memory listings dict for redis and the event bus for redis pub/sub
without touching the wire protocol.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import time
from collections import deque
from typing import Any, AsyncIterator


class AgentGateway:
    """Listings store + asyncio fan-out event bus."""

    DEFAULT_TTL_S = 10.0          # listing expires this long after last frame
    HEARTBEAT_S = 15.0            # how often to emit heartbeat events
    SWEEP_INTERVAL_S = 1.0        # how often to scan for expired listings
    ORDER_HISTORY = 200           # cap on remembered orders for /orders
    SUBSCRIBER_QUEUE_MAX = 256    # per-subscriber queue depth before dropping

    def __init__(self, ttl_s: float = DEFAULT_TTL_S, gateway_origin: str = ""):
        self._ttl = ttl_s
        self._origin = gateway_origin.rstrip("/")

        self._listings: dict[str, dict[str, Any]] = {}
        self._orders: deque[dict[str, Any]] = deque(maxlen=self.ORDER_HISTORY)

        self._subscribers: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._sweeper_task: asyncio.Task | None = None
        self._heartbeat_task: asyncio.Task | None = None

    # ---------- lifecycle ----------

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind to the running event loop and start background tasks. Call
        from the FastAPI startup hook."""
        self._loop = loop
        self._sweeper_task = loop.create_task(self._sweep_loop())
        self._heartbeat_task = loop.create_task(self._heartbeat_loop())

    async def shutdown(self) -> None:
        for t in (self._sweeper_task, self._heartbeat_task):
            if t is not None:
                t.cancel()
        for q in list(self._subscribers):
            try:
                q.put_nowait({"event": "shutdown", "data": {}})
            except asyncio.QueueFull:
                pass

    # ---------- ingest from serve.py ----------

    def publish(
        self,
        *,
        label: str,
        rarity: str,
        ref_filename: str,
        set_code: str,
        price_usd: float | None,
        price_jpy: float | None,
        confident: bool,
    ) -> str | None:
        """Called by serve.py for every confident detection. Idempotent across
        frames — only emits an event when state actually changes (new listing
        appeared, or price moved). Keeps `last_seen_ts` fresh so the sweeper
        knows the listing is still in frame.

        Safe to call from sync code; events are scheduled onto the bound loop.
        """
        if not confident or not label or price_usd is None:
            return None

        listing_id = self._listing_id_for(label, ref_filename)
        now = time.time()
        new_price = round(float(price_usd), 2)

        existing = self._listings.get(listing_id)
        if existing is None:
            listing = {
                "listing_id":    listing_id,
                "label":         label,
                "rarity":        rarity,
                "ref_filename":  ref_filename,
                "ref_url":       self._ref_url(ref_filename),
                "set_code":      set_code,
                "price_usd":     new_price,
                "price_jpy":     int(price_jpy) if price_jpy is not None else None,
                "first_seen_ts": now,
                "last_seen_ts":  now,
                "frames_seen":   1,
            }
            self._listings[listing_id] = listing
            self._emit("listing.appeared", listing)
        else:
            existing["last_seen_ts"] = now
            existing["frames_seen"] += 1
            if abs(existing["price_usd"] - new_price) >= 0.01:
                existing["price_usd"] = new_price
                if price_jpy is not None:
                    existing["price_jpy"] = int(price_jpy)
                self._emit("listing.price", existing)
            # otherwise: no event — heartbeat sweeper will keep things alive

        return listing_id

    # ---------- snapshot reads (cold-start fallback for new subscribers) ----------

    def list_live(self) -> list[dict[str, Any]]:
        now = time.time()
        out = []
        for l in self._listings.values():
            age = now - l["last_seen_ts"]
            if age > self._ttl:
                continue
            out.append({**l, "expires_in_s": round(self._ttl - age, 1), "status": "live"})
        out.sort(key=lambda x: -x["last_seen_ts"])
        return out

    def recent_orders(self, limit: int = 25) -> list[dict[str, Any]]:
        return list(self._orders)[-limit:][::-1]

    # ---------- agent-facing writes ----------

    def buy(
        self,
        *,
        listing_id: str,
        agent_id: str = "anon",
        max_price_usd: float | None = None,
    ) -> dict[str, Any]:
        now = time.time()
        order_id = "ord_" + secrets.token_hex(6)
        listing = self._listings.get(listing_id)

        if listing is None or (now - listing["last_seen_ts"]) > self._ttl:
            order = {
                "order_id":      order_id,
                "listing_id":    listing_id,
                "agent_id":      agent_id,
                "label":         listing["label"] if listing else None,
                "price_usd":     None,
                "max_price_usd": max_price_usd,
                "status":        "rejected_no_listing",
                "reason":        "listing not found or already expired",
                "created_at":    now,
                "receipt":       None,
            }
            self._orders.append(order)
            self._emit("order.rejected", order)
            return order

        price = listing["price_usd"]
        if max_price_usd is not None and price > float(max_price_usd):
            order = {
                "order_id":      order_id,
                "listing_id":    listing_id,
                "agent_id":      agent_id,
                "label":         listing["label"],
                "price_usd":     price,
                "max_price_usd": max_price_usd,
                "status":        "rejected_too_expensive",
                "reason":        f"price ${price:.2f} > max ${float(max_price_usd):.2f}",
                "created_at":    now,
                "receipt":       None,
            }
            self._orders.append(order)
            self._emit("order.rejected", order)
            return order

        order = {
            "order_id":      order_id,
            "listing_id":    listing_id,
            "agent_id":      agent_id,
            "label":         listing["label"],
            "rarity":        listing["rarity"],
            "ref_url":       listing["ref_url"],
            "set_code":      listing["set_code"],
            "price_usd":     price,
            "price_jpy":     listing.get("price_jpy"),
            "max_price_usd": max_price_usd,
            "status":        "filled",
            "created_at":    now,
            "receipt":       "rcpt_" + secrets.token_hex(8),
        }
        self._orders.append(order)
        self._emit("order.filled", order)
        return order

    # ---------- SSE subscriber API ----------

    async def subscribe(self) -> AsyncIterator[str]:
        """Async generator yielding text/event-stream frames. On connect,
        replays current live listings as `listing.appeared` events so a fresh
        subscriber sees the world before any new events arrive."""
        q: asyncio.Queue = asyncio.Queue(maxsize=self.SUBSCRIBER_QUEUE_MAX)
        self._subscribers.add(q)
        try:
            # Cold-start replay
            yield self._format_frame("ready", {
                "ttl_s": self._ttl,
                "now": time.time(),
                "live_count": len(self._listings),
            })
            for snap in self.list_live():
                yield self._format_frame("listing.appeared", snap)

            while True:
                evt = await q.get()
                if evt.get("event") == "shutdown":
                    return
                yield self._format_frame(evt["event"], evt["data"])
        finally:
            self._subscribers.discard(q)

    # ---------- discovery ----------

    def manifest(self) -> dict[str, Any]:
        return {
            "name": "data-label-factory agent gateway",
            "version": "0.1.0",
            "description": (
                "SSE event bus exposing a live webcam-driven marketplace. Any "
                "object the upstream identifier recognizes becomes a buyable "
                "listing while it's in frame. MCP servers and LLM agents can "
                "subscribe to /api/agent/stream and POST /api/agent/buy."
            ),
            "currency": "USD",
            "settlement": "demo",
            "transport": "sse",
            "endpoints": {
                "manifest":  "/api/agent/manifest",
                "stream":    "/api/agent/stream",
                "snapshot":  "/api/agent/listings",
                "buy":       "/api/agent/buy",
                "orders":    "/api/agent/orders",
                "ref_image": "/refs/<ref_filename>",
            },
            "events": [
                "ready", "listing.appeared", "listing.price", "listing.expired",
                "order.filled", "order.rejected", "heartbeat",
            ],
            "buy_request_schema": {
                "listing_id":    "string (required, from a listing.appeared event)",
                "agent_id":      "string (optional, your stable ID)",
                "max_price_usd": "number (optional, refuse if listing > this)",
            },
            "notes": [
                "Listings are ephemeral — only valid while the physical object "
                "is in frame. After ttl_s with no fresh frame, you'll see a "
                "listing.expired event and POST /buy will reject it.",
                "Demo settlement: filled orders return a fake receipt; no money "
                "moves. Swap AgentGateway.buy() for a real adapter (stripe / "
                "x402 / lightning) without changing the wire protocol.",
            ],
        }

    # ---------- internals ----------

    def _emit(self, event: str, data: dict[str, Any]) -> None:
        """Fan out an event to all current subscribers. Drops on overflow
        rather than blocking the caller (camera loop must stay realtime)."""
        if not self._subscribers:
            return
        payload = {"event": event, "data": data}
        loop = self._loop
        if loop is None:
            return
        # Schedule onto the loop in case we were called from a sync context.
        loop.call_soon_threadsafe(self._fanout_now, payload)

    def _fanout_now(self, payload: dict[str, Any]) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                # Slow consumer — drop this event for them. They'll catch up
                # on the next snapshot poll.
                pass

    async def _sweep_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self.SWEEP_INTERVAL_S)
                now = time.time()
                expired_ids = [
                    lid for lid, l in self._listings.items()
                    if (now - l["last_seen_ts"]) > self._ttl
                ]
                for lid in expired_ids:
                    listing = self._listings.pop(lid, None)
                    if listing is not None:
                        self._fanout_now({
                            "event": "listing.expired",
                            "data": {
                                "listing_id":    listing["listing_id"],
                                "label":         listing["label"],
                                "frames_seen":   listing["frames_seen"],
                                "last_seen_ts":  listing["last_seen_ts"],
                            },
                        })
        except asyncio.CancelledError:
            return

    async def _heartbeat_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self.HEARTBEAT_S)
                self._fanout_now({
                    "event": "heartbeat",
                    "data": {
                        "ts": time.time(),
                        "live_listings": len(self._listings),
                        "subscribers":   len(self._subscribers),
                    },
                })
        except asyncio.CancelledError:
            return

    @staticmethod
    def _format_frame(event: str, data: dict[str, Any]) -> str:
        # SSE wire format: one frame = `event: <name>\ndata: <json>\n\n`
        return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"

    @staticmethod
    def _listing_id_for(label: str, ref_filename: str) -> str:
        h = hashlib.sha1(f"{label}|{ref_filename}".encode()).hexdigest()[:8]
        return f"lst_{h}"

    def _ref_url(self, ref_filename: str) -> str:
        if not ref_filename:
            return ""
        if self._origin:
            return f"{self._origin}/refs/{ref_filename}"
        return f"/refs/{ref_filename}"


def install(app, gateway: AgentGateway) -> None:
    """Mount gateway HTTP routes onto a FastAPI app and wire startup/shutdown.
    Kept separate from AgentGateway so the store stays framework-free."""
    from fastapi import HTTPException
    from fastapi.responses import JSONResponse, StreamingResponse
    from typing import Optional
    from pydantic import BaseModel

    class BuyRequest(BaseModel):
        listing_id: str
        agent_id: Optional[str] = None
        max_price_usd: Optional[float] = None

    @app.on_event("startup")
    async def _gateway_startup() -> None:
        gateway.attach_loop(asyncio.get_running_loop())

    @app.on_event("shutdown")
    async def _gateway_shutdown() -> None:
        await gateway.shutdown()

    @app.get("/.well-known/agent-gateway.json")
    def well_known() -> JSONResponse:
        return JSONResponse(content=gateway.manifest())

    @app.get("/api/agent/manifest")
    def manifest() -> JSONResponse:
        return JSONResponse(content=gateway.manifest())

    @app.get("/api/agent/listings")
    def listings_snapshot() -> JSONResponse:
        live = gateway.list_live()
        return JSONResponse(content={
            "ok":    True,
            "count": len(live),
            "listings": live,
            "ttl_s": gateway._ttl,
            "now":   time.time(),
        })

    @app.get("/api/agent/orders")
    def orders(limit: int = 25) -> JSONResponse:
        recent = gateway.recent_orders(limit=limit)
        return JSONResponse(content={"ok": True, "count": len(recent), "orders": recent})

    @app.get("/api/agent/stream")
    async def stream() -> StreamingResponse:
        return StreamingResponse(
            gateway.subscribe(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",   # disable nginx buffering if proxied
                "Connection": "keep-alive",
            },
        )

    @app.post("/api/agent/buy")
    def buy(req: BuyRequest) -> JSONResponse:
        if not req.listing_id:
            raise HTTPException(400, "listing_id required")
        order = gateway.buy(
            listing_id=req.listing_id,
            agent_id=req.agent_id or "anon",
            max_price_usd=req.max_price_usd,
        )
        ok = order["status"] == "filled"
        return JSONResponse(status_code=200 if ok else 402, content={"ok": ok, "order": order})
