#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
prefix=${PREFIX:-"$HOME/.local"}
bindir=${BINDIR:-"$prefix/bin"}
command_name=${COMMAND_NAME:-wisc}
target="$bindir/$command_name"

if ! command -v node >/dev/null 2>&1; then
    echo "error: node is required but was not found in PATH" >&2
    exit 1
fi

if [ ! -d "$repo_root/node_modules" ]; then
    echo "Installing Node dependencies..."
    (cd "$repo_root" && npm install)
fi

mkdir -p "$bindir"
chmod +x "$repo_root/bin/wisc"
ln -sf "$repo_root/bin/wisc" "$target"

echo "Installed $command_name -> $repo_root/bin/wisc"
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
echo "  $command_name calibration_images/IMG_9953.HEIC --optpar-out calibration.json --code python"
