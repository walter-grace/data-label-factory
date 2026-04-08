"""data_label_factory.runpod — optional GPU path via RunPod.

Defaults to local Mac execution. This subpackage is only loaded when the user
explicitly invokes `python3 -m data_label_factory.runpod`.

See README.md in this folder for architecture, costs, and usage.
"""

__all__ = ["main"]


def main():
    """Lazy entry point — keeps `runpod` SDK import out of the global namespace."""
    from .cli import main as _main
    return _main()
