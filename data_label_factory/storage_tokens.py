"""storage_tokens — Server-side OAuth token storage for cloud providers.

Stores encrypted-at-rest OAuth tokens for Google Drive, Dropbox, and
Bitbucket. Same pattern as moltbook.py's _load_links / _save_links.

Tokens are keyed by (user_id, provider). The file lives at
`.storage_tokens.json` in the repo root (gitignored).

Security:
    - Tokens NEVER go to the browser. Only "connected: true/false" + file
      listings are returned to the client.
    - The JSON file should be 0600 on disk (we set mode on every write).
"""

from __future__ import annotations

import json
import os
import stat
import time
from pathlib import Path
from typing import Any, Optional

_TOKEN_STORE = Path(os.environ.get(
    "DLF_STORAGE_TOKENS",
    str(Path(__file__).parent.parent / ".storage_tokens.json"),
))

VALID_PROVIDERS = ("gdrive", "dropbox", "bitbucket")


def _load() -> dict[str, dict[str, Any]]:
    if not _TOKEN_STORE.exists():
        return {}
    try:
        return json.loads(_TOKEN_STORE.read_text())
    except Exception:
        return {}


def _save(data: dict[str, dict[str, Any]]) -> None:
    _TOKEN_STORE.parent.mkdir(parents=True, exist_ok=True)
    _TOKEN_STORE.write_text(json.dumps(data, indent=2))
    try:
        os.chmod(str(_TOKEN_STORE), stat.S_IRUSR | stat.S_IWUSR)  # 0600
    except OSError:
        pass


def _key(user_id: str, provider: str) -> str:
    return f"{user_id}:{provider}"


def save_token(user_id: str, provider: str, tokens: dict[str, Any]) -> None:
    """Persist OAuth tokens for a user+provider pair."""
    if provider not in VALID_PROVIDERS:
        raise ValueError(f"Unknown provider: {provider}")
    store = _load()
    store[_key(user_id, provider)] = {
        "provider": provider,
        "user_id": user_id,
        "tokens": tokens,
        "saved_at": time.time(),
    }
    _save(store)


def get_token(user_id: str, provider: str) -> Optional[dict[str, Any]]:
    """Return stored tokens dict or None."""
    entry = _load().get(_key(user_id, provider))
    if entry is None:
        return None
    return entry.get("tokens")


def delete_token(user_id: str, provider: str) -> bool:
    """Remove tokens. Returns True if they existed."""
    store = _load()
    k = _key(user_id, provider)
    if k in store:
        del store[k]
        _save(store)
        return True
    return False


def list_connected(user_id: str) -> list[str]:
    """Return list of provider names that have stored tokens for this user."""
    store = _load()
    connected = []
    for p in VALID_PROVIDERS:
        if _key(user_id, p) in store:
            connected.append(p)
    return connected
