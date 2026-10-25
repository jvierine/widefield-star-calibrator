# Compatibility mapper templates

These are the standalone mapper bodies ported from `js/export_generators.js`.
Rust fills only model, full-precision parameters, and image dimensions. There
is no JavaScript evaluation or generation step in native/WASM builds or exports.
The Python mapper includes its own forward/inverse numerical lens functions;
the C, Julia, and MATLAB mappers are self-contained forward projections.

Changes to projection conventions must update these kernels and their executable
cross-language regression tests. Perspective/Brown back-facing rays are rejected
consistently with the shared core, including the exact antipodal optical axis.
