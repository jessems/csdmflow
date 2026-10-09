#!/bin/bash
# extract-slides.sh <deck.pptx> [out-dir]
# Renders every slide of a PowerPoint deck to out-dir/slide-NNN.png (1920px wide)
# for the compare app. Uses Microsoft PowerPoint for the PDF export: Keynote's
# .pptx import re-routes elbow connectors and swaps fonts, which silently changes
# what the diagrams show. Needs python3 + pymupdf (pip install pymupdf).
set -euo pipefail
deck="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
out="${2:-.slides}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
# PowerPoint is sandboxed: export into the output folder (it may write there, the shell can read it)
pdf="$out/deck-powerpoint.pdf"
osascript <<OSA 2>&1 | grep -v sandbox_extension || true
tell application "Microsoft PowerPoint"
  open POSIX file "$deck"
  delay 5
  save active presentation in POSIX file "$pdf" as save as PDF
  close active presentation saving no
end tell
OSA
python3 - "$pdf" "$out" <<'PY'
import sys, pymupdf
doc = pymupdf.open(sys.argv[1])
for i, page in enumerate(doc):
    z = 1920 / page.rect.width
    page.get_pixmap(matrix=pymupdf.Matrix(z, z)).save(f"{sys.argv[2]}/slide-{i + 1:03d}.png")
print(f"{len(doc)} slides -> {sys.argv[2]}")
PY
