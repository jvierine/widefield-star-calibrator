#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
prefix=${PREFIX:-"$HOME/.local"}
bindir=${BINDIR:-"$prefix/bin"}
command_name=${COMMAND_NAME:-widefield-star-calibrate}
target="$bindir/$command_name"

if ! command -v node >/dev/null 2>&1; then
    echo "error: node is required but was not found in PATH" >&2
    exit 1
fi

mkdir -p "$bindir"
chmod +x "$repo_root/bin/widefield-star-calibrate"
ln -sf "$repo_root/bin/widefield-star-calibrate" "$target"

echo "Installed $command_name -> $repo_root/bin/widefield-star-calibrate"
echo "Install directory: $bindir"

case ":$PATH:" in
    *":$bindir:"*) ;;
    *)
        echo
        echo "Add this to your shell startup file if $command_name is not found:"
        echo "  export PATH=\"$bindir:\$PATH\""
        ;;
esac

if ! command -v sips >/dev/null 2>&1; then
    echo
    echo "warning: macOS 'sips' was not found."
    echo "         PNG inputs can still work, but HEIC/JPEG normalization needs sips."
fi

echo
echo "Try:"
echo "  $command_name calibration_images/IMG_9953.HEIC --optpar-out calibration.json --code python"
