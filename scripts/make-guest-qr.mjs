// 차량 앱 게스트 QR 자리표시 이미지(정적 VectorDrawable)를 만든다. 아무 의미 없는 고정 문자열을 인코딩하며 앱은 런타임에 QR을 만들지 않는다.
// 사용: node scripts/make-guest-qr.mjs > car/app/src/main/res/drawable/guest_qr.xml   (toqr는 pnpm 스토어에 있는 것을 쓴다)
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const store = join(root, "node_modules/.pnpm");
const dir = readdirSync(store).find((d) => d.startsWith("toqr@"));
if (!dir) throw new Error("toqr를 찾지 못했습니다(pnpm install 필요)");
const { toQR } = createRequire(import.meta.url)(
  join(store, dir, "node_modules/toqr"),
);

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
