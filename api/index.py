"""Vercel Python serverless function entry point.

Vercel detects this file and serves the FastAPI app as a serverless function.
All /backend/* requests are rewritten to hit this function via vercel.json.

In production, storage paths point to /tmp (ephemeral but works for warm
instances). Seed data (communities, templates) is always re-created.
"""

import os
import sys

# Ensure the project root is on sys.path so `data_label_factory` is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Point storage to /tmp on Vercel (no persistent filesystem)
if os.environ.get("VERCEL"):
    os.environ.setdefault("DLF_COMMUNITY_DIR", "/tmp/dlf-communities")
    os.environ.setdefault("DLF_MOLTBOOK_LINKS", "/tmp/dlf-moltbook-links.json")
    os.environ.setdefault("DLF_UPLOAD_DIR", "/tmp/dlf-uploads")
    os.environ.setdefault("DLF_TEMPLATE_DIR", "/tmp/dlf-templates")

from data_label_factory.serve import app as _app  # noqa: E402
from starlette.middleware.base import BaseHTTPMiddleware  # noqa: E402
from starlette.requests import Request  # noqa: E402


class StripPrefixMiddleware(BaseHTTPMiddleware):
    """Strip /backend prefix added by Vercel's rewrite rule.

    Vercel rewrites /backend/api/providers → /api/index, but the ASGI app
    receives the ORIGINAL path (/backend/api/providers). FastAPI routes are
    defined as /api/providers, so we strip the /backend prefix.
    """
    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith("/backend"):
            scope = request.scope
            scope["path"] = scope["path"][len("/backend"):]
            scope["raw_path"] = scope["path"].encode()
        return await call_next(request)


if os.environ.get("VERCEL"):
    _app.add_middleware(StripPrefixMiddleware)

app = _app
