// 차량 앱 게스트 QR 자리표시 이미지(정적 VectorDrawable)를 만든다. 아무 의미 없는 고정 문자열을 인코딩하며 앱은 런타임에 QR을 만들지 않는다.
// 생성물(guest_qr.xml)은 커밋돼 있어 평소에는 다시 돌릴 필요가 없다. 바꿀 때만 toqr@0.1.1이 해석되는 빈 폴더에서 돌린다:
//   mkdir /tmp/guest-qr && cd /tmp/guest-qr && npm init -y && npm i toqr@0.1.1
//   cp <저장소>/scripts/make-guest-qr.mjs . && node make-guest-qr.mjs > <저장소>/car/app/src/main/res/drawable/guest_qr.xml
// (ESM import는 스크립트 위치에서 toqr를 찾으므로 스크립트를 그 폴더에 복사해 실행한다.)
import { toQR } from 'toqr';

const bits = toQR("NUBI-GUEST-QR-PLACEHOLDER", 1);
const n = Math.round(Math.sqrt(bits.length));
if (n * n !== bits.length)
  throw new Error(`정사각형이 아닙니다: ${bits.length}`);
const quiet = 2; // 여백(모듈)
const size = n + quiet * 2;
let path = "";
for (let y = 0; y < n; y++) {
  let x = 0;
  while (x < n) {
    if (!bits[y * n + x]) {
      x++;
      continue;
    }
    let w = 1;
    while (x + w < n && bits[y * n + x + w]) w++;
    path += `M${x + quiet},${y + quiet}h${w}v1h-${w}z`;
    x += w;
  }
}
console.log(`<?xml version="1.0" encoding="utf-8"?>
<!-- 생성: scripts/make-guest-qr.mjs. 고정 문자열 'NUBI-GUEST-QR-PLACEHOLDER'의 QR(${n}x${n}). 의미 없는 자리표시이며 아직 동작하지 않는다 -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${size}dp"
    android:height="${size}dp"
    android:viewportWidth="${size}"
    android:viewportHeight="${size}">
    <path android:fillColor="#EEF2F7" android:pathData="M0,0h${size}v${size}h-${size}z" />
    <path android:fillColor="#0F141B" android:pathData="${path}" />
</vector>`);
