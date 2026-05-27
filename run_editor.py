#!/usr/bin/env python3
"""
NeuralWeave Pipeline Editor - Node-based visual pipeline builder
"""

import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

from pipeline_editor import main

if __name__ == "__main__":
    main()
