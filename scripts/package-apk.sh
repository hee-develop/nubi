#!/usr/bin/env bash
# 사용법: scripts/package-apk.sh <팀명> [앱이름=누비] [--server https://...]
set -euo pipefail

TEAM="" ; APP="" ; SERVER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:-}"; [ -n "$SERVER" ] || { echo "오류: --server 값이 비어 있습니다" >&2; exit 2; }; shift 2 ;;
    *) if [ -z "$TEAM" ]; then TEAM="$1"; elif [ -z "$APP" ]; then APP="$1"; else echo "오류: 알 수 없는 인자 $1" >&2; exit 2; fi; shift ;;
  esac
done
APP="${APP:-누비}"
if [ -z "${TEAM// /}" ]; then
  echo "사용법: $0 <팀명> [앱이름=누비] [--server https://...]" >&2
  echo "오류: 팀명이 비어 있습니다" >&2
  exit 2
fi
case "$TEAM$APP" in */*|*..*) echo "오류: 팀명·앱이름에 / 또는 .. 를 쓸 수 없습니다" >&2; exit 2 ;; esac
if [ -n "$SERVER" ] && [[ "$SERVER" != https://* ]]; then
  echo "오류: --server는 https:// 로 시작해야 합니다(release는 TLS 필수): $SERVER" >&2; exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)"
[ -n "$BT" ] && [ -x "$BT/apksigner" ] || { echo "오류: apksigner를 찾지 못했습니다(ANDROID_HOME 확인)" >&2; exit 1; }

ARGS=(:app:assembleRelease)
[ -n "$SERVER" ] && ARGS+=("-Pnubi.releaseServerUrl=$SERVER")
(cd "$ROOT/car" && ./gradlew "${ARGS[@]}")

SRC="$ROOT/car/app/build/outputs/apk/release/app-release.apk"
[ -f "$SRC" ] || { echo "오류: 서명된 app-release.apk가 없습니다. 키스토어 설정(NUBI_KEYSTORE_PROPS 또는 ~/.nubi/keystore.properties)을 확인하세요" >&2; exit 1; }

"$BT/apksigner" verify --verbose "$SRC"

mkdir -p "$ROOT/apk"
DEST="$ROOT/apk/${TEAM}_${APP}_release.apk"
cp "$SRC" "$DEST"
SHA="$(shasum -a 256 "$DEST" | awk '{print $1}')"
BADGE="$("$BT/aapt" dump badging "$DEST" | head -1)"
VNAME="$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$BADGE")"
VCODE="$(sed -n "s/.*versionCode='\([^']*\)'.*/\1/p" <<<"$BADGE")"
PKG="$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$BADGE")"
README="$ROOT/apk/README.md"
[ -f "$README" ] || printf '# 제출용 APK\n\n`scripts/package-apk.sh`가 만든 서명된 release APK와 SHA-256 기록입니다.\n\n| 파일 | 패키지 | 버전 | 서버 | SHA-256 | 생성 시각(UTC) |\n|---|---|---|---|---|---|\n' > "$README"
printf '| `%s` | %s | %s (%s) | %s | `%s` | %s |\n' "$(basename "$DEST")" "$PKG" "$VNAME" "$VCODE" "${SERVER:-미설정(자리표시)}" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$README"
echo "완료: $DEST"
echo "SHA-256: $SHA  버전: $VNAME ($VCODE)"
