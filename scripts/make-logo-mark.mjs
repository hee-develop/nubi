// 누비 로고 마크(점선 호 + 끝 점)를 VectorDrawable로 만든다. 시안 00-brand.html의 SVG를 옮긴 것이다.
// VectorDrawable은 stroke-dasharray를 지원하지 않아, 곡선을 호 길이로 샘플링해 점선(9 켬 · 11 끔)을 별도 하위 경로로 낸다.
// 사용: node scripts/make-logo-mark.mjs > car/app/src/main/res/drawable/logo_mark.xml
const seg1 = [
  [24, 88],
  [22, 56],
  [50, 34],
  [68, 52],
];
const seg2 = [
  [68, 52],
  [86, 70],
  [84, 88],
  [97, 41],
]; // `S 84 88, 97 41`: 첫 제어점은 앞 제어점의 반사
const bez = (p, t) => {
  const u = 1 - t;
  return [0, 1].map(
    (i) =>
      u ** 3 * p[0][i] +
      3 * u * u * t * p[1][i] +
      3 * u * t * t * p[2][i] +
      t ** 3 * p[3][i],
  );
};
const pts = [];
for (const s of [seg1, seg2])
  for (let i = pts.length ? 1 : 0; i <= 400; i++) pts.push(bez(s, i / 400));
const cum = [0];
for (let i = 1; i < pts.length; i++)
  cum.push(
    cum[i - 1] +
      Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]),
  );
const total = cum[cum.length - 1];
const at = (d) => {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const f = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return [
    pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
    pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f,
  ];
};
const r = (v) => Math.round(v * 100) / 100;
let dashes = "";
for (let s = 0; s < total; s += 20) {
  const e = Math.min(s + 9, total);
  const a = at(s);
  dashes += `M${r(a[0])},${r(a[1])}`;
  for (let d = s + 1.5; d < e; d += 1.5)
    dashes += `L${r(at(d)[0])},${r(at(d)[1])}`;
  const b = at(e);
  dashes += `L${r(b[0])},${r(b[1])}`;
}
console.log(`<?xml version="1.0" encoding="utf-8"?>
<!-- 생성: scripts/make-logo-mark.mjs (시안 00-brand.html 마크). 점선은 호 길이 샘플링으로 만든 하위 경로다 -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="120dp"
    android:height="120dp"
    android:viewportWidth="120"
    android:viewportHeight="120">
    <path
        android:fillColor="#171E27"
        android:strokeColor="#2A3544"
        android:strokeWidth="3"
        android:pathData="M31,3h58a28,28 0 0 1 28,28v58a28,28 0 0 1 -28,28h-58a28,28 0 0 1 -28,-28v-58a28,28 0 0 1 28,-28z" />
    <path
        android:strokeColor="#F59E0B"
        android:strokeWidth="6"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:pathData="${dashes}" />
    <path
        android:fillColor="#F59E0B"
        android:pathData="M97,32a9,9 0 1 0 0.001,0z" />
</vector>`);
