# Shared Rust engine acceptance — original GUI preserved

The product GUI is the original `index.html`, `style.css`, and `js/app.js`.
Its layout, white cards, controls, labels, interactions and existing features
are not replaced by a Rust-specific UI. JavaScript GUI code is explicitly
allowed. On phones the same sidebar is hidden behind a gear button.

The built `web/index.html` must equal the original HTML with only the app
bootstrap replaced. `web/style.css` must equal the original stylesheet byte for
byte. `tests/original_gui_browser.cjs` enforces these invariants. The Rust DOM
fixture under `tests/fixtures/` is test infrastructure, not a deployable GUI.

The native `wisc` executable builds and runs without JavaScript, Node.js or a
Python runtime. The browser calls the same portable `wisc-core` via WASM.
Retaining an old GUI workflow does not mean all of its numerical internals
have already been ported; outstanding engine work is explicit below.

| Area | Current shared/native implementation | Remaining engine acceptance work |
|---|---|---|
| Original desktop GUI | Original HTML/CSS/JS, not a recreation; browser invariant and screenshot tests | Keep visual/interaction regressions covered |
| Phone GUI | Same settings panel behind ⚙, automatic phone/coarse-pointer mode, 44px controls, modal focus/backdrop/Escape, portrait/landscape | Broader real iOS/Android checks |
| Phone star picking | Two-tap image/catalogue pairing and safe pinch/pan without a keyboard; browser test | More real-device/multi-touch regressions |
| Eight lens models and inverse mapping | Shared Rust, browser projection adapter, native independent Python/C checks | Broader real-image model regressions |
| Camera rotations and ground star coordinates | Browser adapters call shared Rust; native Astropy checks | Broader epoch/near-pole regressions |
| NM/LM fitting | Production GUI and CLI use same engine, no JS recenter/refit; native/WASM agreement tested | Robust/outlier regressions across more fixtures |
| Fixed coefficients | Shared NM/LM active-parameter API; spacecraft Brown k2/k3/p1/p2 remain exactly fixed; CLI --fixed | Broader spacecraft parameter-policy fixtures |
| Manual pairing/deleting/undo | Original full JavaScript GUI retained | All centroid/detection internals to shared Rust |
| Detection/KDE | Rust detector and 40× KDE available natively and in WASM acceptance fixture | Connect original GUI detector/KDE paths without changing picker behavior |
| Automatic identification | Full original lucky/annulus/NN/faint-star/diagnostic GUI remains; native seeded and triangle matching exist | Full native lucky pipeline, annulus/NN/faint-star expansion and Yale index |
| Image decoding/metadata | Native/core PNG/JPEG/HEIC/FITS stack decoder and EXIF/site metadata | Converge original GUI decode paths with the same native implementation |
| Display/grids/labels | Original GUI controls and appearance retained; shared histogram and viewport primitives tested | Connect remaining display/grid internals where useful, no redesign |
| Catalogues | Corrected 42,047-star Tycho subset, original TYC IDs, named Yale and TD1; shared native catalogue loader | Native precomputed Yale asterism index |
| Ground interchange | Native JSON/HDF5/report ZIP/session import; exact SHA binding; legacy names, altitude, flips/excluded table provenance | Uncommon older attributes and ambiguous-coordinate explicit conversion |
| Maps | Native FITS degree planes and compressed full pixel-corner HDF5; independent Astropy/SciPy/h5py checks | Complete product naming compatibility |
| MIRACLE | Shared SVD fits, ASCII/JSON/HDF5, statistics and explicit fallback; independent NumPy checks | Full native comparison-table/absolute-angular-error figure |
| Reports | Native Rustplotlib ZIP/HTML/LaTeX, source manifest/hash, no duplicate source PNG, rich HDF5, mappers/readers | Remaining original montage/TSV/embedded catalogue examples |
| Code exports | Rust Python/MATLAB/Julia/C mappers and optpar, all eight models; Python/C actually executed | Execute generated Julia/MATLAB when runtimes are available |
| Hosted/GAIA | Original full GUI retained; Rust API; native-engine fit integrated; real local API/protocol tests | Production read-only checks and original-GUI submission acceptance |
| Spacecraft/SMILE | Original ECEF/limb/disc/UV/SMILE/session GUI retained; constrained fitting shared Rust | Native ephemeris/limb/disc/occultation/sequence engine and legacy spacecraft HDF5 |
| Help/audio/keyboard | Original GUI interactions retained; phone controls supplement keyboard | Keep help accurate about which numerical ports are complete |
| Deployment | Public API already Rust; pure-Rust CLI available | Push/CI, original-GUI engine rollout and rollback checks; urdr access still required |

## Verification

Run `cargo test --locked --workspace`, strict Clippy, `scripts/build_web.sh`,
and the complete `npm run test:all` scientific compatibility gate with no skips.
The original GUI browser test is the production UI acceptance test; the older
`rust_*_browser.cjs` tests exercise a separate engine fixture, local API,
session/report and GAIA protocol behavior. They never submit to production.

`verify_rust_report.py` checks original image bytes, rich HDF5 through h5py,
independent NumPy MIRACLE fits and native ZIP/JSON/HDF provenance round trips.
`verify_rust_code_exports.py` executes generated Python/C for all models.
`verify_rust_exports.py` independently checks maps with Astropy and SciPy.

No feature is intentionally removed. Do not claim the entire numerical
migration complete merely because compatibility tests or the GUI pass.
