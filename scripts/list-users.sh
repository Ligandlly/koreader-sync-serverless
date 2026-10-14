#!/usr/bin/env bash
#
# List registered users from a running KOReader sync instance.
#
#   bash scripts/list-users.sh [options]
#
# Works against the Aliyun FC deployment (default) or any running instance.
# The admin token is read from --token, $ADMIN_TOKEN or deploy/aliyun/.env; the
# base URL from --url, $FUNCTION_URL, the FC HTTP trigger (via the aliyun CLI)
# or http://localhost:8787 as a fallback.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/aliyun/.env"

# Aliyun API + *.fcapp.run must bypass any local HTTP proxy.
export NO_PROXY="aliyuncs.com,.aliyuncs.com,fcapp.run,.fcapp.run,localhost,127.0.0.1,${NO_PROXY:-}"
export no_proxy="$NO_PROXY"
export ALIBABA_CLOUD_CLI_AI_MODE=1

usage() {
  cat <<'EOF'
List registered users from a running KOReader sync instance.

Usage:
  bash scripts/list-users.sh [options]

Options:
  --url <base>     Base URL (default: FC trigger URL, else http://localhost:8787)
  --token <token>  Admin token (default: $ADMIN_TOKEN or deploy/aliyun/.env)
  --local          Shorthand for --url http://localhost:8787
  --json           Print the raw JSON response instead of a table
  -h, --help       Show this help

Environment overrides:
  FUNCTION_URL     Base URL used when --url is not given
  ADMIN_TOKEN      Admin token used when --token is not given
EOF
}

URL="${FUNCTION_URL:-}"
TOKEN="${ADMIN_TOKEN:-}"
OUTPUT="table"

while [ $# -gt 0 ]; do
  case "$1" in
    --url)   URL="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --local) URL="http://localhost:8787"; shift ;;
    --json)  OUTPUT="json"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

env_value() {
  # Read KEY=value from deploy/aliyun/.env
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true
}

if [ -z "$TOKEN" ]; then
  TOKEN="$(env_value ADMIN_TOKEN)"
fi

if [ -z "$URL" ]; then
  if command -v aliyun >/dev/null 2>&1 && [ -f "$ENV_FILE" ]; then
    region="$(env_value REGION)"; region="${region:-cn-hangzhou}"
    fn="$(env_value FUNCTION_NAME)"; fn="${fn:-koreader-sync}"
    URL="$(aliyun fc GetTrigger --region "$region" --functionName "$fn" \
      --triggerName http --cli-query 'httpTrigger.urlInternet' 2>/dev/null | tr -d '"' || true)"
  fi
fi
URL="${URL:-http://localhost:8787}"
URL="${URL%/}"

if [ -z "$TOKEN" ]; then
  echo "No admin token found. Pass --token or set ADMIN_TOKEN (see deploy/aliyun/.env)." >&2
  exit 1
fi

command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
JAR="$TMP_DIR/cookies.txt"

info() { printf '%s\n' "$*" >&2; }

# --- admin login -------------------------------------------------------------
login_body="$(python3 -c 'import json,sys; print(json.dumps({"token": sys.argv[1]}))' "$TOKEN")"
login_code="$(curl -sS -o "$TMP_DIR/login.json" -w '%{http_code}' -c "$JAR" \
  -X POST "$URL/admin/auth/login" \
  -H 'Content-Type: application/json' \
  --data-binary "$login_body" || true)"

if [ "$login_code" != "200" ]; then
  body="$(cat "$TMP_DIR/login.json" 2>/dev/null || true)"
  info "Admin login failed (HTTP ${login_code:-no response}) at $URL"
  [ -n "$body" ] && info "$body"
  exit 1
fi

# The session cookie is marked Secure, which curl refuses to send over plain
# HTTP. Read the value out of the jar and pass it as a Cookie header manually so
# local (http://) instances work too.
COOKIE="$(awk '$6 == "ks_admin_session" {print $7}' "$JAR" | tail -n1)"
if [ -z "$COOKIE" ]; then
  info "Admin login did not return a session cookie."
  exit 1
fi

# --- fetch users -------------------------------------------------------------
users_code="$(curl -sS -o "$TMP_DIR/users.json" -w '%{http_code}' \
  -H "Cookie: ks_admin_session=$COOKIE" "$URL/admin/users" || true)"

if [ "$users_code" != "200" ]; then
  body="$(cat "$TMP_DIR/users.json" 2>/dev/null || true)"
  info "Failed to list users (HTTP ${users_code:-no response}) at $URL"
  [ -n "$body" ] && info "$body"
  exit 1
fi

if [ "$OUTPUT" = "json" ]; then
  cat "$TMP_DIR/users.json"; echo
  exit 0
fi

# --- pretty table ------------------------------------------------------------
python3 - "$TMP_DIR/users.json" "$URL" <<'PY'
import datetime
import json
import sys

path, url = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path))
except json.JSONDecodeError:
    sys.exit("Response was not valid JSON")

items = data.get("items", []) if isinstance(data, dict) else data
print(f"Server: {url}")
print(f"Users : {len(items)}")
print()

if not items:
    sys.exit(0)

width = max([len("USERNAME")] + [len(str(u.get("username", ""))) for u in items])
print(f"{'ID':>6}  {'USERNAME':<{width}}  {'CREATED':<19}")
print(f"{'-' * 6}  {'-' * width}  {'-' * 19}")

for u in items:
    ts = u.get("created_at")
    when = datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S") if ts else "-"
    print(f"{str(u.get('id', '')):>6}  {str(u.get('username', '')):<{width}}  {when:<19}")
PY
