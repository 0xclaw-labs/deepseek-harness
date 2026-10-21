# Brand assets (build-time inputs)

Drop the branded icon files here (PNG/ICO with the same names the upstream
packaging expects):

- `icon-macos.png` – macOS app icon source (`apps/desktop/resources/icon-macos.png`)
- `icon-windows.png` – Windows executable icon (`apps/desktop/resources/icon-windows.png`)
- `tray-windows.ico` – Windows tray bitmap (`apps/desktop/resources/tray-windows.ico`)

`custom/branding/apply-brand.mjs --write` copies these over the upstream paths
in the build worktree only (git in this fork never stores modified upstream
assets; see `UPSTREAM.md`). If a file is absent the upstream icon stays in
place and `--strict` reports it.

Keep the sizing/format identical to the upstream originals so electron-builder
validation keeps passing.
