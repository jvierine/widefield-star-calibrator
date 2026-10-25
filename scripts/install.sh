#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
prefix=${PREFIX:-"$HOME/.local"}
bindir=${BINDIR:-"$prefix/bin"}
command_name=${COMMAND_NAME:-wisc}
target="$bindir/$command_name"

if ! command -v cargo >/dev/null 2>&1 && ! command -v rustup >/dev/null 2>&1; then
    echo "error: Rust cargo is required but was not found in PATH" >&2
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

echo "Building the native Rust calibrator..."
(cd "$repo_root" && "$cargo_bin" build --locked --release -p wisc-cli)

mkdir -p "$bindir"
install -m 0755 "$repo_root/target/release/wisc" "$target"

echo "Installed native Rust executable: $target"
echo "Install directory: $bindir"

case ":$PATH:" in
    *":$bindir:"*) ;;
    *)
        echo
        echo "Add this to your shell startup file if $command_name is not found:"
        echo "  export PATH=\"$bindir:\$PATH\""
        ;;
esac

echo
echo "Try:"
echo "  $command_name --help"
echo "  $command_name fit fit-job.json --output calibration.json --residual-plot residuals.pdf"
