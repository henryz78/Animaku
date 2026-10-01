#!/bin/sh
set -e

# 如果以 root 身份运行容器（默认初始容器环境），且挂载了 DATA_DIR
if [ "$(id -u)" = "0" ]; then
  DATA_DIR="${DATA_DIR:-/app/data}"

  if [ -d "$DATA_DIR" ]; then
    # 检查 data 目录属主是否已经是 node (UID 1000) 且具备写权限
    # 若宿主机创建的挂载目录属主为 root:root 或权限受限，自动修复为 node 可写
    OWNER_UID=$(stat -c '%u' "$DATA_DIR" 2>/dev/null || stat -f '%u' "$DATA_DIR" 2>/dev/null || echo "")
    if [ "$OWNER_UID" != "1000" ] || [ ! -w "$DATA_DIR" ]; then
      chown -R node:node "$DATA_DIR" 2>/dev/null || chmod -R 777 "$DATA_DIR" 2>/dev/null || true
    fi
  fi

  # 使用 gosu 降权为 node 用户执行主进程，保证容器内应用以非 root 安全运行
  if command -v gosu >/dev/null 2>&1; then
    exec gosu node "$@"
  elif command -v su-exec >/dev/null 2>&1; then
    exec su-exec node "$@"
  else
    exec su -s /bin/sh node -c 'exec "$@"' -- "$@"
  fi
fi

# 若容器启动时已由外部显式指定非 root 用户运行，直接执行主进程
exec "$@"
