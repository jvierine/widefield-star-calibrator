# Full Rust migration acceptance

Full feature parity is required before switching the public application.
The legacy application stays available while this checklist is incomplete.
Passing compatibility tests checks the old algorithms; it does **not** mean
that every legacy workflow has been ported to the new Rust application.

Sources: root `index.html`, `js/app.js`, the helper modules under `js/`, and
README/help. The Rust replacement is `web/` plus the three `crates/wisc-*`
packages. No feature below is intentionally dropped.

| Area | Current replacement | Remaining acceptance work |
|---|---|---|
| Eight optical models and inverse projection | Shared Rust implementation, reference and round-trip tests | Continue real-image regressions across every model |
| Nelder–Mead and Levenberg–Marquardt | Both shared native/WASM; LM tested on every model and BACC | Broader robust/outlier and cross-target LM regressions |
| Manual star pairing, deleting, undo, clearing | Rust UI, detection snapping, 40× KDE picker | Legacy selection shortcuts, KDE-only dots, configurable patch/search controls and full density diagnostics |
| Automatic identification | Seeded matching and triangle pointing recovery; retains manual pairs | Full lucky multi-stage lens/annulus hypotheses, faint-star expansion, pruning, NN tuning and asterism diagnostics |
| Image input | PNG/JPEG/HEIC/HEIF/FITS, stack integration, byte-order override | Drag/drop, startup demo, sequence workflows |
| Image metadata | Shared EXIF date/offset/subseconds/GPS/camera metadata; station/date filename fallbacks; FITS time/site | Broader metadata fixtures, expose/preserve altitude and all metadata in exported sessions |
| Zoom/pan | Cursor-anchored wheel zoom 1–16×, drag pan, reset | Legacy +/- controls, magnifier, touch controls and persistent view state |
| Display | Brightness, contrast, gamma, RGB and Gaussian high-pass display | Percentile clipping/stretch parity and image flips |
| Bad detections | Toggle 128×128 mask tiles, excluded from automatic matching | Paint-on-drag/keyboard masking, detector re-run with masks, serialize/undo masks and individual rejected detections |
| Sky and image views | Catalogue projections, image/sky and marker toggles | Full Stellarium appearance, names/identities, independent marker layers and exact shortcut semantics |
| Coordinate overlays | Azimuth/zenith grid | Celestial RA/Dec grid, labels and exact legacy grid controls |
| Residual diagnostics | Rustplotlib plot, on-image ×20 vectors | Full residual tables/statistics, legacy residual-only view and plot export buttons |
| Lens controls | All 8/12 coefficients editable; native CLI model parameters | Model/image flips, modifier-wheel/drag lens manipulation, pointing reset, FOV controls, 3D orientation visualization and equations |
| Catalogues | Bundled Tycho-2 to magnitude 8 | TD1 UV, Yale asterism index/names and catalogue selector |
| Calibration interchange | JSON and new Rust HDF5; legacy raw-coordinate ground HDF5 import | Preserve rich star identities/exclusions/session metadata; older ambiguous-coordinate files require explicit conversion; spacecraft HDF5 and report ZIP import |
| Coordinate maps | FITS planes; compressed full pixel-corner HDF5 | Complete legacy metadata/product naming compatibility |
| MIRACLE compatibility | Not ported | Equidistant/equisolid fits, residual statistics, summary tables and legacy datasets |
| Reports | Standalone calibration/map files, native Rustplotlib residual figures | ZIP bundles, LaTeX, overlays/montages, base image, standalone reader/overlay/map scripts |
| Code exports | Native Rust CLI and JSON | Copy/export optpar and Python/MATLAB/Julia/C compatibility generators |
| Hosted test cases | Rust API backend exists independently | New UI list/load/save, passkey handling, share links and quick-link routing |
| GAIA integration | Existing public legacy UI remains connected | Image/settings/refit-proposal import, masks, observation headers, calibration upload and opener notification |
| Spacecraft geometry | Not integrated into replacement | ECEF/ENU, attitude seeding, WGS84 limb/occultation, UV selection, disc detection and fitting |
| SMILE handoff and sessions | Not ported | Validated observation import/export, origin/token checks, opener messaging, per-frame autosave, session archives and star-pick restoration |
| Help and accessibility | Rust workflow documented separately; labelled controls/status | Feature-by-feature help, shortcut parity, progress/cancel, keyboard/mobile acceptance |
| Optional audio/easter eggs | Not ported | Retain optional legacy interactions without adding scientific dependencies |
| Deployment | Native CLI installed on juha.no/revontuli; API already Rust | Full UI parity gate, complete host verification, urdr access and rollout/rollback checks |

## Verification

Run `cargo test --locked --workspace`, strict Clippy, and `scripts/build_web.sh`.
`tests/rust_web_browser.cjs` exercises the **Rust** UI in real Chromium/WebGL:
NM/LM fit (including native/WASM LM projection agreement within 0.00001 pixel),
zoom/pan without accidental pairing, scientific overlays, display
isolation, masks, KDE, undo, and HDF5 download. CI runs this after the WASM build.
Install Playwright 1.62.1 and its Chromium binary to run it locally; a separately
installed package may be supplied through `NODE_PATH`. An existing browser
binary can be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

Keep the legacy full scientific suite (`npm run test:all`) green throughout the
migration. New features need Rust-native tests and browser/native workflow tests;
retaining the old JavaScript implementation is not a completed Rust port.
