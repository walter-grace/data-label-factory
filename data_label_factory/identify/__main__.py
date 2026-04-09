"""Enables `python3 -m data_label_factory.identify <command>`."""

from .cli import main
import sys

if __name__ == "__main__":
    sys.exit(main())
