#!/usr/bin/env bash
#
# One-time provisioning of the Aliyun resources needed by the KOReader sync
# service on Function Compute:
#   * a VPC + vSwitch + security group (reuses the account default VPC when present)
#   * an NFS NAS file system + VPC mount target (persistent SQLite storage)
#
# Idempotent: safe to re-run. Configuration is stored in deploy/aliyun/.env.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/aliyun/.env"
EXAMPLE_FILE="$ROOT/deploy/aliyun/.env.example"

export ALIBABA_CLOUD_CLI_AI_MODE=1
# Aliyun API calls must bypass any local HTTP proxy.
export NO_PROXY="aliyuncs.com,.aliyuncs.com,${NO_PROXY:-}"
export no_proxy="$NO_PROXY"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }; }
need aliyun
need python3

set_env() {
  python3 - "$ENV_FILE" "$1" "$2" <<'PY'
import sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().splitlines()
out, found = [], False
for line in lines:
    if line.startswith(key + "="):
        out.append(f"{key}={value}")
        found = True
    else:
        out.append(line)
if not found:
    out.append(f"{key}={value}")
open(path, "w").write("\n".join(out) + "\n")
PY
}

jq_string() {
  # Extract a plain string value from JSON on stdin.
  python3 -c 'import sys,json; v=json.load(sys.stdin); print(v if isinstance(v,str) else (v[0] if isinstance(v,list) and v else ""))'
}

json_query() {
  # json_query <file> <python-expression evaluated with d=data>
  python3 - "$1" "$2" <<'PY'
import sys, json
data = json.load(open(sys.argv[1]))
d = data
print(eval(sys.argv[2]))
PY
}

if [ ! -f "$ENV_FILE" ]; then
  cp "$EXAMPLE_FILE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  set_env PASSWORD_PEPPER "$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  set_env ADMIN_TOKEN "$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  echo "Created $ENV_FILE with freshly generated secrets."
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
REGION="${REGION:-cn-hangzhou}"
echo "Region: $REGION"

# ---------------------------------------------------------------------------
# VPC / vSwitch / security group
# ---------------------------------------------------------------------------
if [ -z "${VPC_ID:-}" ]; then
  VPC_ID="$(aliyun vpc DescribeVpcs --region "$REGION" --cli-query 'Vpcs.Vpc[?IsDefault==`true`] | [0].VpcId' 2>/dev/null | tr -d '"' || true)"
fi
if [ -z "${VPC_ID:-}" ] || [ "$VPC_ID" = "None" ]; then
  echo "No default VPC found, creating one..."
  VPC_ID="$(aliyun vpc CreateVpc --region "$REGION" --CidrBlock 172.16.0.0/12 --cli-query 'VpcId' | tr -d '"')"
  ZONE="$(aliyun ecs DescribeZones --region "$REGION" --cli-query 'Zones.Zone[0].ZoneId' | tr -d '"')"
  VSWITCH_ID="$(aliyun vpc CreateVswitch --region "$REGION" --CidrBlock 172.16.0.0/20 --VpcId "$VPC_ID" --ZoneId "$ZONE" --cli-query 'VSwitchId' | tr -d '"')"
fi
set_env VPC_ID "$VPC_ID"
echo "VPC: $VPC_ID"

if [ -z "${VSWITCH_ID:-}" ]; then
  VSWITCH_ID="$(aliyun vpc DescribeVSwitches --region "$REGION" --VpcId "$VPC_ID" --cli-query 'VSwitches.VSwitch[0].VSwitchId' | tr -d '"')"
fi
set_env VSWITCH_ID "$VSWITCH_ID"
echo "vSwitch: $VSWITCH_ID"

if [ -z "${SECURITY_GROUP_ID:-}" ]; then
  SECURITY_GROUP_ID="$(aliyun ecs DescribeSecurityGroups --region "$REGION" --VpcId "$VPC_ID" --cli-query 'SecurityGroups.SecurityGroup[0].SecurityGroupId' 2>/dev/null | tr -d '"' || true)"
fi
if [ -z "${SECURITY_GROUP_ID:-}" ] || [ "$SECURITY_GROUP_ID" = "None" ]; then
  SECURITY_GROUP_ID="$(aliyun ecs CreateSecurityGroup --region "$REGION" --VpcId "$VPC_ID" --SecurityGroupName koreader-sync-fc --cli-query 'SecurityGroupId' | tr -d '"')"
fi
set_env SECURITY_GROUP_ID "$SECURITY_GROUP_ID"
echo "Security group: $SECURITY_GROUP_ID"

# ---------------------------------------------------------------------------
# NAS (NFS) + VPC mount target
# ---------------------------------------------------------------------------
if [ -z "${NAS_FILE_SYSTEM_ID:-}" ]; then
  aliyun nas DescribeFileSystems --region "$REGION" > /tmp/nas-list.json
  NAS_FILE_SYSTEM_ID="$(json_query /tmp/nas-list.json "
next((f['FileSystemId'] for f in d.get('FileSystems',{}).get('FileSystem',[])
     if f.get('ProtocolType')=='NFS' and f.get('StorageType')=='Capacity' and f.get('Status')=='Running'), '')")"
fi

if [ -z "${NAS_FILE_SYSTEM_ID:-}" ]; then
  echo "Creating an NFS (Capacity) NAS file system..."
  NAS_FILE_SYSTEM_ID="$(aliyun nas CreateFileSystem --region "$REGION" \
    --FileSystemType standard --ProtocolType NFS --StorageType Capacity \
    --ChargeType PayAsYouGo --cli-query 'FileSystemId' | tr -d '"')"
  # Wait until the file system is running.
  for _ in $(seq 1 30); do
    status="$(aliyun nas DescribeFileSystems --region "$REGION" --FileSystemId "$NAS_FILE_SYSTEM_ID" --cli-query 'FileSystems.FileSystem[0].Status' | tr -d '"')"
    [ "$status" = "Running" ] && break
    sleep 5
  done
fi
set_env NAS_FILE_SYSTEM_ID "$NAS_FILE_SYSTEM_ID"
echo "NAS file system: $NAS_FILE_SYSTEM_ID"

if [ -z "${NAS_MOUNT_TARGET_DOMAIN:-}" ]; then
  aliyun nas DescribeMountTargets --region "$REGION" --FileSystemId "$NAS_FILE_SYSTEM_ID" > /tmp/nas-mounts.json
  NAS_MOUNT_TARGET_DOMAIN="$(json_query /tmp/nas-mounts.json "
next((m['MountTargetDomain'] for m in d.get('MountTargets',{}).get('MountTarget',[])
     if m.get('VpcId')=='$VPC_ID' and m.get('VswId')=='$VSWITCH_ID'), '')")"
fi

if [ -z "${NAS_MOUNT_TARGET_DOMAIN:-}" ]; then
  echo "Creating a VPC mount target for the NAS..."
  NAS_MOUNT_TARGET_DOMAIN="$(aliyun nas CreateMountTarget --region "$REGION" \
    --FileSystemId "$NAS_FILE_SYSTEM_ID" --NetworkType Vpc \
    --VpcId "$VPC_ID" --VSwitchId "$VSWITCH_ID" \
    --AccessGroupName DEFAULT_VPC_GROUP_NAME --cli-query 'MountTargetDomain' | tr -d '"')"
  for _ in $(seq 1 30); do
    status="$(aliyun nas DescribeMountTargets --region "$REGION" --FileSystemId "$NAS_FILE_SYSTEM_ID" --MountTargetDomain "$NAS_MOUNT_TARGET_DOMAIN" --cli-query 'MountTargets.MountTarget[0].Status' | tr -d '"')"
    [ "$status" = "Active" ] && break
    sleep 5
  done
fi
set_env NAS_MOUNT_TARGET_DOMAIN "$NAS_MOUNT_TARGET_DOMAIN"
set_env NAS_MOUNT_DIR "${NAS_MOUNT_DIR:-/mnt/data}"
echo "NAS mount target: $NAS_MOUNT_TARGET_DOMAIN"

echo
echo "Provisioning complete. deploy/aliyun/.env now contains all resource ids."
echo "Next: npm run deploy:aliyun"
