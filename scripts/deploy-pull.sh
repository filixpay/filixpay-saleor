#!/bin/bash
# Pull pre-built image from GHCR and restart (no local docker build).
#
# Usage (public image — default):
#   ./scripts/deploy-pull.sh
#
# Optional overrides:
#   SALEOR_IMAGE=ghcr.io/filixpay/filixpay-saleor:latest
#   SALEOR_CONTAINER=filixpay-saleor
#   ENV_FILE=.env
#
# Private packages only — set DEPLOY_ENV_FILE with:
#   GHCR_USER=your-github-username
#   GHCR_TOKEN=ghp_...   # classic PAT with read:packages

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE="${SALEOR_IMAGE:-ghcr.io/filixpay/filixpay-saleor:latest}"
CONTAINER_NAME="${SALEOR_CONTAINER:-filixpay-saleor}"
APP_ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"

if [[ -n "${DEPLOY_ENV_FILE:-}" && -f "$DEPLOY_ENV_FILE" ]]; then
	echo "📄 Loading GHCR credentials from $DEPLOY_ENV_FILE"
	# shellcheck disable=SC1090
	source "$DEPLOY_ENV_FILE"
	IMAGE="${SALEOR_IMAGE:-$IMAGE}"
	CONTAINER_NAME="${SALEOR_CONTAINER:-$CONTAINER_NAME}"
fi

if [[ -n "${GHCR_TOKEN:-}" && -n "${GHCR_USER:-}" ]]; then
	echo "🔐 登录 GHCR..."
	echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
else
	echo "ℹ️  未配置 GHCR 凭证，按公开镜像匿名拉取"
fi

echo "📥 拉取镜像 $IMAGE ..."
docker pull "$IMAGE"

pulled_image_id=$(docker image inspect -f '{{.Id}}' "$IMAGE")

running_image_id=""
container_running=false
if docker inspect "$CONTAINER_NAME" &>/dev/null; then
	running_image_id=$(docker inspect -f '{{.Image}}' "$CONTAINER_NAME")
	container_running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME")
fi

if [[ "$container_running" == "true" && -n "$running_image_id" && "$running_image_id" == "$pulled_image_id" ]]; then
	short_id="${pulled_image_id#sha256:}"
	short_id="${short_id:0:12}"
	echo "ℹ️  镜像未变化，与当前运行实例相同（${short_id}），跳过重启。"
	exit 0
fi

echo "▶️  重启容器（无本地 build）..."
cd "$REPO_ROOT"
export SKIP_BUILD=1
export CANDIDATE_IMAGE="$IMAGE"
export SALEOR_CONTAINER="$CONTAINER_NAME"
export ENV_FILE="$APP_ENV_FILE"

bash "$REPO_ROOT/deploy.sh"

echo "🧹 清理 dangling 镜像..."
docker image prune -f

echo "✅ 部署完成"
docker ps --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
