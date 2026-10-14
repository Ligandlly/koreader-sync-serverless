#!/usr/bin/env bash
#
# Build and deploy the KOReader sync service to Aliyun Function Compute 3.0.
#
#   npm run deploy:aliyun
#
# Reads deploy/aliyun/.env (run `npm run provision:aliyun` first), bundles the
# FC handler with esbuild, uploads the code package inline and creates/updates
# the function, its VPC/NAS config and the anonymous HTTP trigger.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/aliyun/.env"

export ALIBABA_CLOUD_CLI_AI_MODE=1
export NO_PROXY="aliyuncs.com,.aliyuncs.com,${NO_PROXY:-}"
export no_proxy="$NO_PROXY"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE. Run 'npm run provision:aliyun' first." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
REGION="${REGION:-cn-hangzhou}"
FUNCTION_NAME="${FUNCTION_NAME:-koreader-sync}"
NAS_MOUNT_DIR="${NAS_MOUNT_DIR:-/mnt/data}"

if [ -z "${NAS_MOUNT_TARGET_DOMAIN:-}" ]; then
  echo "NAS_MOUNT_TARGET_DOMAIN is not set. Run 'npm run provision:aliyun' first." >&2
  exit 1
fi

echo "==> Building FC bundle"
node "$ROOT/scripts/build-fc.mjs"

echo "==> Packaging dist-fc"
rm -f /tmp/koreader-sync-fc.zip /tmp/koreader-sync-fc.b64
(cd "$ROOT/dist-fc" && zip -q -r /tmp/koreader-sync-fc.zip .)
base64 -i /tmp/koreader-sync-fc.zip | tr -d '\n' > /tmp/koreader-sync-fc.b64

echo "==> Preparing function configuration"
python3 - "$ENV_FILE" /tmp/koreader-sync-fc.b64 /tmp/koreader-sync-fc-body.json "$NAS_MOUNT_DIR" <<'PY'
import json, sys
env_path, b64_path, out_path, mount_dir = sys.argv[1:5]
env = {}
for line in open(env_path):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    env[key] = value
b64 = open(b64_path).read().strip()
body = {
    "functionName": env.get("FUNCTION_NAME", "koreader-sync"),
    "runtime": "nodejs20",
    "handler": "index.handler",
    "code": {"zipFile": b64},
    "description": "KOReader sync service (Hono on FC, SQLite via sql.js on NAS)",
    "memorySize": 512,
    "cpu": 0.5,
    "timeout": 60,
    "diskSize": 512,
    "instanceConcurrency": 1,
    "environmentVariables": {
        "PASSWORD_PEPPER": env["PASSWORD_PEPPER"],
        "ADMIN_TOKEN": env["ADMIN_TOKEN"],
        "SQLITE_PATH": env.get("SQLITE_PATH", "/mnt/data/koreader-sync.db"),
        "SESSION_TTL_HOURS": env.get("SESSION_TTL_HOURS", "168"),
        "RUNTIME_TARGET": "node",
        "DB_DRIVER": "sqlite",
    },
    "vpcConfig": {
        "vpcId": env["VPC_ID"],
        "vSwitchIds": [env["VSWITCH_ID"]],
        "securityGroupId": env["SECURITY_GROUP_ID"],
    },
    "nasConfig": {
        "userId": 0,
        "groupId": 0,
        "mountPoints": [
            {
                "serverAddr": f"{env['NAS_MOUNT_TARGET_DOMAIN']}:/",
                "mountDir": mount_dir,
                "enableTLS": False,
            }
        ],
    },
}
json.dump(body, open(out_path, "w"))
print(f"code package: {len(b64)} base64 chars")
PY

if aliyun fc GetFunction --region "$REGION" --functionName "$FUNCTION_NAME" --cli-query 'functionName' >/dev/null 2>&1; then
  echo "==> Updating existing function $FUNCTION_NAME"
  aliyun fc UpdateFunction --region "$REGION" --functionName "$FUNCTION_NAME" \
    --body "$(cat /tmp/koreader-sync-fc-body.json)" >/dev/null
else
  echo "==> Creating function $FUNCTION_NAME"
  aliyun fc CreateFunction --region "$REGION" \
    --body "$(cat /tmp/koreader-sync-fc-body.json)" >/dev/null
fi

if [ "$(aliyun fc ListTriggers --region "$REGION" --functionName "$FUNCTION_NAME" --cli-query "triggers[?triggerName=='http'] | length(@)" | tr -d ' ')" = "0" ]; then
  echo "==> Creating anonymous HTTP trigger"
  aliyun fc CreateTrigger --region "$REGION" --functionName "$FUNCTION_NAME" \
    --body '{"triggerName":"http","triggerType":"http","triggerConfig":"{\"authType\":\"anonymous\",\"methods\":[\"GET\",\"POST\",\"PUT\",\"DELETE\",\"PATCH\",\"HEAD\",\"OPTIONS\"],\"disableURLInternet\":false}"}' >/dev/null
fi

URL="$(aliyun fc GetTrigger --region "$REGION" --functionName "$FUNCTION_NAME" --triggerName http --cli-query 'httpTrigger.urlInternet' | tr -d '"')"
echo
echo "Deployed successfully."
echo "  Function : $FUNCTION_NAME ($REGION)"
echo "  URL      : $URL"
echo "  Admin UI : $URL/admin  (log in with ADMIN_TOKEN from deploy/aliyun/.env)"
