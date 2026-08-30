#!/bin/bash
set -Eeuo pipefail

# ================= 配置区域 =================
CONTAINER_NAME="${SALEOR_CONTAINER:-filixpay-saleor}"
IMAGE_NAME="${SALEOR_IMAGE_NAME:-filixpay-saleor}"
ENV_FILE="${ENV_FILE:-.env}"
PORT_HOST="${PORT_HOST:-3001}"
PORT_CONTAINER="${PORT_CONTAINER:-3001}"
BIND_HOST="${BIND_HOST:-127.0.0.1}"
DATA_VOLUME="${DATA_VOLUME:-filixpay-saleor-data}"
# Production pull path: scripts/deploy-pull.sh sets SKIP_BUILD=1 and CANDIDATE_IMAGE.
SKIP_BUILD="${SKIP_BUILD:-0}"
IMAGE_REF="${CANDIDATE_IMAGE:-${IMAGE_NAME}:latest}"
# ===========================================

echo "🚀 开始智能部署 [${CONTAINER_NAME}]..."

if [ "${SKIP_BUILD}" != "1" ] && [ ! -f "Dockerfile" ]; then
  echo "❌ 错误：当前目录找不到 Dockerfile！"
  exit 1
fi

if [ "${SKIP_BUILD}" = "1" ] && [ -z "${CANDIDATE_IMAGE:-}" ]; then
  echo "❌ 错误：SKIP_BUILD=1 需要设置 CANDIDATE_IMAGE（Registry 镜像地址）。"
  exit 1
fi

# 停止并删除旧容器
echo "🛑 清理旧容器..."
docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

# 构建镜像（CI / pull 部署时跳过）
if [ "${SKIP_BUILD}" = "1" ]; then
  echo "📦 使用预构建镜像 ${IMAGE_REF}（SKIP_BUILD=1）..."
else
  echo "🔨 正在构建镜像（--no-cache）..."
  docker build --no-cache --pull -t "${IMAGE_NAME}:latest" .

  if [ $? -ne 0 ]; then
    echo "❌ 镜像构建失败！请检查上方报错。"
    exit 1
  fi
  echo "✅ 镜像构建成功！"
  IMAGE_REF="${IMAGE_NAME}:latest"
fi

# 启动新容器
echo "📦 正在启动容器 (端口: ${BIND_HOST}:${PORT_HOST}:${PORT_CONTAINER})..."

RUN_ARGS=(
  -d
  --name "${CONTAINER_NAME}"
  -p "${BIND_HOST}:${PORT_HOST}:${PORT_CONTAINER}"
  -v "${DATA_VOLUME}:/data"
  -e NODE_ENV=production
  --restart unless-stopped
)

if [ -f "$ENV_FILE" ]; then
  echo "📄 检测到 $ENV_FILE，将加载环境变量..."
  RUN_ARGS+=(--env-file "$ENV_FILE")
else
  echo "⚠️ 未找到 $ENV_FILE，仅使用镜像内环境变量..."
fi

RUN_ARGS+=("${IMAGE_REF}")

docker run "${RUN_ARGS[@]}"

# 检查状态
sleep 2
STATUS=$(docker inspect -f '{{.State.Status}}' "${CONTAINER_NAME}" 2>/dev/null || true)

if [ "$STATUS" = "running" ]; then
  echo "✅ 容器启动成功！"
  echo ""
  echo "📊 运行信息："
  docker ps --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
  echo ""
  echo "🔗 访问地址: http://${BIND_HOST}:${PORT_HOST}"
  echo "💡 查看实时日志: docker logs -f ${CONTAINER_NAME}"
else
  echo "❌ 容器启动失败或立即退出！状态: ${STATUS:-未知}"
  echo "📝 最后 20 行日志:"
  docker logs --tail 20 "${CONTAINER_NAME}" 2>/dev/null || echo "无法获取日志（容器可能未创建）"
  exit 1
fi
