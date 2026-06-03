#!/usr/bin/env bash
set -euo pipefail

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

remote=${AIDA_DEPLOY_REMOTE:-j@juha.no}
live_dir=${AIDA_DEPLOY_LIVE_DIR:-/var/www/aida}
mirror_dir=${AIDA_DEPLOY_MIRROR_DIR:-/var/www/html/aida}
service=${AIDA_DEPLOY_SERVICE:-wisc-aida-api.service}
api_url=${AIDA_DEPLOY_API_URL:-https://juha.no/api/test-cases}
app_url=${AIDA_DEPLOY_APP_URL:-https://juha.no/aida/js/app.js}
api_port=${AIDA_DEPLOY_API_PORT:-8790}
json_body_limit=${AIDA_DEPLOY_JSON_BODY_LIMIT:-134217728}
image_body_limit=${AIDA_DEPLOY_IMAGE_BODY_LIMIT:-67108864}

rsync_excludes=(
    --exclude=.git
    --exclude=node_modules
    --exclude=__pycache__
    --exclude=test-report
)

usage() {
    cat <<EOF
Usage: $(basename "$0") [--dry-run] [--delete] [--skip-restart] [--skip-verify]

Deploy WISC/AIDA to the juha.no web server.

Environment overrides:
  AIDA_DEPLOY_REMOTE       default: $remote
  AIDA_DEPLOY_LIVE_DIR     default: $live_dir
  AIDA_DEPLOY_MIRROR_DIR   default: $mirror_dir
  AIDA_DEPLOY_SERVICE      default: $service
  AIDA_DEPLOY_API_URL      default: $api_url
  AIDA_DEPLOY_APP_URL      default: $app_url
  AIDA_DEPLOY_API_PORT     default: $api_port
  AIDA_DEPLOY_JSON_BODY_LIMIT default: $json_body_limit
  AIDA_DEPLOY_IMAGE_BODY_LIMIT default: $image_body_limit
EOF
}

dry_run=0
delete_extra=0
skip_restart=0
skip_verify=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --dry-run)
            dry_run=1
            ;;
        --delete)
            delete_extra=1
            ;;
        --skip-restart)
            skip_restart=1
            ;;
        --skip-verify)
            skip_verify=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "error: required command not found: $1" >&2
        exit 1
    fi
}

require_command rsync
require_command ssh
require_command curl

rsync_args=(-az)
if [ "$delete_extra" -eq 1 ]; then
    rsync_args+=(--delete)
fi
if [ "$dry_run" -eq 1 ]; then
    rsync_args+=(--dry-run --itemize-changes)
fi
rsync_args+=("${rsync_excludes[@]}")

echo "Deploy source: $repo_root"
echo "Remote: $remote"
echo "Live target: $live_dir"
echo "Mirror target: $mirror_dir"

rsync "${rsync_args[@]}" "$repo_root/" "$remote:$live_dir/"
rsync "${rsync_args[@]}" "$repo_root/" "$remote:$mirror_dir/"

if [ "$dry_run" -eq 1 ]; then
    echo "Dry run complete; not restarting or verifying."
    exit 0
fi

if [ "$skip_restart" -eq 0 ]; then
    echo "Restarting $service on $remote..."
    ssh -o BatchMode=yes "$remote" \
        "set -eu
         dropin_dir='/etc/systemd/system/${service}.d'
         sudo -n mkdir -p \"\$dropin_dir\"
         printf '%s\n' '[Service]' \
             'Environment=AIDA_MAX_JSON_BODY_BYTES=${json_body_limit}' \
             'Environment=AIDA_MAX_IMAGE_BYTES=${image_body_limit}' |
             sudo -n tee \"\$dropin_dir/aida-limits.conf\" >/dev/null
         sudo -n systemctl daemon-reload
         sudo -n systemctl stop '$service' || true
         pkill -f 'node .*${live_dir}/tools/serve_calibrator\\.js.*--port ${api_port}' || true
         sleep 1
         sudo -n systemctl start '$service'
         systemctl is-active --quiet '$service'
         systemctl status '$service' --no-pager --lines=8"
else
    echo "Skipping service restart."
fi

if [ "$skip_verify" -eq 0 ]; then
    cache_bust=$(date +%Y%m%d%H%M%S)
    echo "Verifying public app URL..."
    app_head=$(curl -fsSL "${app_url}?deploy=${cache_bust}" | sed -n '1,8p')
    printf '%s\n' "$app_head"
    printf '%s\n' "$app_head" | grep -q 'APP_VERSION'

    echo "Verifying public API URL..."
    curl -fsSL "$api_url" >/dev/null

    echo "Verifying FITS allow-list in running server module..."
    ssh -o BatchMode=yes "$remote" \
        "grep -q 'application/fits' '$live_dir/tools/serve_calibrator.js'
         grep -q 'image/fits' '$live_dir/tools/serve_calibrator.js'
         systemctl is-active --quiet '$service'"
fi

echo "Deploy complete."
