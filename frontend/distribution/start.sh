#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if command -v python3 >/dev/null 2>&1; then
  python3 run_miraviewer.py
else
  echo "Python 3 is required to run MiraViewer." >&2
  echo "Install Python 3 from python.org and try again." >&2
  exit 1
fi
