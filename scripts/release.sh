#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  scripts/release.sh [版本号]

示例：
  # 自动生成版本号（默认：本地时间 YYYY.MM.DD-tHHMMSS）
  scripts/release.sh

  # 指定版本号
  scripts/release.sh 2026.01.04-t233700

可选参数：
  --utc              使用 UTC 时间生成版本号
  --remote <name>    推送到哪个 remote（默认：origin）
  --branch <name>    推送哪个分支（默认：当前分支）
  --allow-dirty      允许工作区存在未提交改动（不推荐）
  --dry-run          只打印将要执行的操作，不实际修改/提交/推送
  -h, --help         显示帮助

说明：
  - 脚本会：更新 package.json 的 version -> 提交 -> 打 tag -> push 分支 + tag
  - 触发 GitHub Actions 后，GHCR 会生成 :latest 以及 :<tag>（取决于你的 workflow）
EOF
}

die() {
  echo "[release] $*" >&2
  exit 1
}

REMOTE="origin"
BRANCH=""
ALLOW_DIRTY="false"
USE_UTC="false"
DRY_RUN="false"
VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --utc)
      USE_UTC="true"
      shift
      ;;
    --remote)
      [[ $# -ge 2 ]] || die "缺少参数：--remote <name>"
      REMOTE="$2"
      shift 2
      ;;
    --branch)
      [[ $# -ge 2 ]] || die "缺少参数：--branch <name>"
      BRANCH="$2"
      shift 2
      ;;
    --allow-dirty)
      ALLOW_DIRTY="true"
      shift
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    --*)
      die "未知参数：$1（用 -h 查看帮助）"
      ;;
    *)
      if [[ -n "$VERSION" ]]; then
        die "多余参数：$1（版本号只能传一个）"
      fi
      VERSION="$1"
      shift
      ;;
  esac
done

command -v git >/dev/null 2>&1 || die "未找到 git"
command -v node >/dev/null 2>&1 || die "未找到 node"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "当前目录不是 git 仓库"

if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi

if [[ -z "$VERSION" ]]; then
  if [[ "$USE_UTC" == "true" ]]; then
    VERSION="$(date -u +"%Y.%m.%d-t%H%M%S")"
  else
    VERSION="$(date +"%Y.%m.%d-t%H%M%S")"
  fi
fi

if ! [[ "$VERSION" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-t[0-9]{6}$ ]]; then
  die "版本号格式不合法：$VERSION（期望：YYYY.MM.DD-tHHMMSS，例如 2026.01.04-t233700）"
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  die "remote 不存在：$REMOTE"
fi

if [[ "$ALLOW_DIRTY" != "true" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    die "工作区有未提交改动，请先提交/清理后再执行（或加 --allow-dirty）"
  fi
fi

if git show-ref --tags --quiet --verify "refs/tags/$VERSION"; then
  die "tag 已存在：$VERSION"
fi

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '[dry-run] %q' "$1"
    shift
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf '\n'
    return 0
  fi
  "$@"
}

echo "[release] 版本号：$VERSION"
echo "[release] 分支：$BRANCH"
echo "[release] remote：$REMOTE"

run env AG2API_RELEASE_VERSION="$VERSION" node - <<'NODE'
const fs = require("fs");
const path = require("path");

const pkgPath = path.resolve(process.cwd(), "package.json");
const raw = fs.readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(raw);
const version = process.env.AG2API_RELEASE_VERSION;
if (!version) throw new Error("Missing AG2API_RELEASE_VERSION");
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\\n");
NODE

if [[ "$DRY_RUN" != "true" ]]; then
  if git diff --quiet -- package.json; then
    die "package.json 未发生变化（可能本来就是该版本号？）"
  fi
fi

run git add package.json
run git commit -m "chore(release): $VERSION"
run git tag -a "$VERSION" -m "$VERSION"
run git push "$REMOTE" "$BRANCH"
run git push "$REMOTE" "$VERSION"

echo "[release] 完成：已 push $BRANCH 和 tag $VERSION"
