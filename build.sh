#!/bin/bash
# 打包成 fnOS 可安装的 .fpk
#   用法：./build.sh [--skip-check]
set -euo pipefail
cd "$(dirname "$0")"

FN_PACK="${FN_PACK:-$(command -v fnpack || true)}"
[ -n "$FN_PACK" ] && [ -x "$FN_PACK" ] || FN_PACK="/tmp/fnpack/fnpack"

echo "== 检查结构 =="
for f in manifest ICON.PNG ICON_256.PNG app/ui/config app/server/server.js cmd/main; do
    [ -e "$f" ] || { echo "缺少 $f"; exit 1; }
done

python3 - <<'PY'
import json, sys
files = ['app/ui/config', 'config/privilege', 'config/resource',
         'wizard/install', 'wizard/upgrade', 'wizard/config', 'wizard/uninstall']
for f in files:
    try:
        json.load(open(f))
    except Exception as e:
        sys.exit(f'{f} JSON 无效: {e}')
print('JSON 全部通过')
PY

if [ "${1:-}" != "--skip-check" ]; then
    echo "== 语法检查 =="
    for f in app/server/server.js app/server/lib/*.js app/server/public/app.js; do
        node --check "$f"
    done
    echo "语法通过"
fi

chmod +x cmd/* build.sh scripts/*.sh 2>/dev/null || true
chmod -R a+r app config wizard ICON.PNG ICON_256.PNG manifest

echo "== 打包 =="
"$FN_PACK" build
OUT="$(ls -t ./*.fpk 2>/dev/null | head -n1)"
if [ -n "$OUT" ]; then
    echo "== 完成：$OUT ($(du -h "$OUT" | cut -f1)) =="
else
    echo "== 未找到产物，检查 fnpack 输出 =="
    exit 1
fi
