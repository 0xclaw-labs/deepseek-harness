
## Icon geometry (2026-10-21)
- `icon-macos.png`: 1024×1024 RGBA, 824×824 content area centered (100px transparent
  margin), superellipse (squircle, exponent 5) mask with 4× supersampled edges.
  macOS does not round third-party icons automatically — a full-bleed square PNG
  shows hard 90° corners in Dock/Finder.
- `icon-windows.png`: 1024×1024 RGBA, rounded-square tile (radius 160) with
  transparent corners for Windows 11 taskbar/tile surfaces.
- The build converts the macOS PNG into a complete iconset/icns; do not replace it
  with the raw square artwork.
