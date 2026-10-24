#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
wasm_bindgen_version=0.2.129

if ! command -v cargo >/dev/null 2>&1 && ! command -v rustup >/dev/null 2>&1; then
    echo "error: Rust cargo is required" >&2
    exit 1
fi
cargo_home_dir=${CARGO_HOME:-"$HOME/.cargo"}
if [ -x "$cargo_home_dir/bin/cargo" ]; then
    cargo_bin="$cargo_home_dir/bin/cargo"
elif command -v rustup >/dev/null 2>&1; then
    cargo_bin=$(rustup which --toolchain stable cargo)
else
    cargo_bin=$(command -v cargo)
fi
wasm_bindgen_bin=${WASM_BINDGEN:-}
if [ -z "$wasm_bindgen_bin" ] && command -v wasm-bindgen >/dev/null 2>&1; then
    wasm_bindgen_bin=$(command -v wasm-bindgen)
fi
if [ -z "$wasm_bindgen_bin" ]; then
    cargo_bin_dir=$(dirname "$cargo_bin")
    if [ -x "$cargo_bin_dir/wasm-bindgen" ]; then
        wasm_bindgen_bin="$cargo_bin_dir/wasm-bindgen"
    fi
fi
if [ -z "$wasm_bindgen_bin" ]; then
    if [ -x "$cargo_home_dir/bin/wasm-bindgen" ]; then
        wasm_bindgen_bin="$cargo_home_dir/bin/wasm-bindgen"
    fi
fi
if [ -z "$wasm_bindgen_bin" ]; then
    echo "error: wasm-bindgen-cli $wasm_bindgen_version is required" >&2
    echo "install it with: cargo install wasm-bindgen-cli --version $wasm_bindgen_version --locked" >&2
    exit 1
fi

(cd "$repo_root" && "$cargo_bin" build --locked --release -p wisc-web --target wasm32-unknown-unknown)
mkdir -p "$repo_root/web/pkg"
cp "$repo_root/help.html" "$repo_root/web/help.html"
"$wasm_bindgen_bin" \
    --target web \
    --out-dir "$repo_root/web/pkg" \
    --out-name wisc_web \
    "$repo_root/target/wasm32-unknown-unknown/release/wisc_web.wasm"

echo "Built Rust/WASM application in $repo_root/web/pkg"
