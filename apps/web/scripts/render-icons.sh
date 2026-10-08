#!/usr/bin/env bash
# Renders the home-screen icons in static/ from the superpipeline mark (the same three paths as
# BrandMark.svelte and the favicon in app.html — change them together). The PNGs are committed, so
# this runs only when the mark changes. Needs rsvg-convert (brew install librsvg).
#
# Every icon is a full, opaque square: iOS rounds the corners itself and fills transparency with
# black, and a maskable icon must paint its whole canvas. `scale` is how much of the canvas the
# 24-unit mark spans; the maskable one is smaller so it stays inside the 80% safe zone whatever
# shape a launcher cuts.
set -euo pipefail
cd "$(dirname "$0")/../static"

render() { # <out.png> <px> <scale>
  local out=$1 px=$2 scale=$3
  local s off
  s=$(awk "BEGIN{print 24/$scale}")
  off=$(awk "BEGIN{print -($s-24)/2}")
  rsvg-convert -w "$px" -h "$px" -o "$out" /dev/stdin <<SVG
<svg xmlns="http://www.w3.org/2000/svg" viewBox="$off $off $s $s">
  <rect x="$off" y="$off" width="$s" height="$s" fill="#0f1118"/>
  <g fill="none" stroke="#f4a526" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="6" cy="6" r="2.5"/><path d="M8.5 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h5.5"/><path d="M18 15v6"/>
  </g>
</svg>
SVG
}

render icon-192.png 192 0.72
render icon-512.png 512 0.72
render icon-maskable-512.png 512 0.5
render apple-touch-icon.png 180 0.66
