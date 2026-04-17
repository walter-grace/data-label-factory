"""CLI dispatcher for `python3 -m data_label_factory.identify <command>`.

Subcommands:
    index    → build_index.main
    verify   → verify_index.main
    train    → train.main
    serve    → serve.main

Each is lazy-loaded so users only pay the import cost for the command they
actually invoke.
"""

from __future__ import annotations

import sys


HELP = """\
data_label_factory.identify — open-set image retrieval

usage: python3 -m data_label_factory.identify <command> [options]

commands:
  index           Build a CLIP retrieval index from a folder of reference images
  verify          Self-test an index and report margin / confusable pairs
  train           Contrastive fine-tune a projection head (improves accuracy)
  scrape_prices   Scrape live market prices and cache them as a sidecar to the index
  serve           Run an HTTP server that exposes the index as /api/falcon
  mcp             Run an MCP server that bridges the agent gateway over stdio
  webui-mcp       Run an MCP server for website UI labeling over stdio

run any command with --help for its options. The full blueprint is in
data_label_factory/identify/README.md.
"""


def main(argv: list[str] | None = None) -> int:
    args = list(argv) if argv is not None else sys.argv[1:]
    if not args or args[0] in ("-h", "--help", "help"):
        print(HELP)
        return 0

    cmd = args[0]
    rest = args[1:]

    if cmd == "index":
        from .build_index import main as _main
        return _main(rest)
    if cmd == "verify":
        from .verify_index import main as _main
        return _main(rest)
    if cmd == "train":
        from .train import main as _main
        return _main(rest)
    if cmd in ("scrape_prices", "scrape-prices", "prices"):
        from .scrape_prices import main as _main
        return _main(rest)
    if cmd == "serve":
        from .serve import main as _main
        return _main(rest)
    if cmd in ("mcp", "mcp-server", "mcp_server"):
        from .mcp_server import main as _main
        return _main()
    if cmd in ("webui-mcp", "webui_mcp"):
        from .webui_mcp import main as _main
        return _main()

    print(f"unknown command: {cmd}\n", file=sys.stderr)
    print(HELP, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
