#!/usr/bin/env python3
"""Entry point for Windows/Linux/terminal use.

The code itself lives inside Resizer.app/Contents/Resources so the macOS app is
self-contained and works from any location (Dock, /Applications, translocated).
"""
import os
import runpy
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
os.environ.setdefault("RESIZER_BASE", str(here))  # output/ and work/ stay next to this file
target = here / "Resizer.app" / "Contents" / "Resources" / "resizer.py"
sys.argv[0] = str(target)
runpy.run_path(str(target), run_name="__main__")
