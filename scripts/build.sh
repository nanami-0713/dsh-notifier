#!/bin/bash
# @dsh-external/dsh-notifier build.
# 无 monorepo 依赖：devDependencies 全部来自 npm，node_modules 缺失时自动安装。
# 产物：lib/index.js（host, ESM）+ lib/client.js（web toast 弹窗, ModuleLoader bundle）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -d node_modules ]; then
  echo "=== Installing build dependencies (npm) ==="
  npm install --no-audit --no-fund --loglevel=error
fi

echo "=== Compiling host (tsc src → lib) ==="
npm run build:host

echo "=== Host build complete（client 由 npm run build:client / dev_build_plugin 构建）==="
