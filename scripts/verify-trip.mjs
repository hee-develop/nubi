// E2E 서버 검증: GET /trips/:id 응답(첫째 인자)을 GPX(둘째 인자)의 기준값과 대조한다. 셋째 인자는 목록 응답(트립이 1건뿐인지 확인).
// 실패하면 이유를 stderr에 쓰고 종료 코드 1로 끝난다.
import { readFileSync } from 'node:fs';

const [detailPath, gpxPath, listPath] = process.argv.slice(2);
const trip = JSON.parse(readFileSync(detailPath, 'utf8'));
const gpx = [...readFileSync(gpxPath, 'utf8').matchAll(/<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"/g)].map((m) => ({
  lat: Number(m[1]),
  lon: Number(m[2]),
}));

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

check(gpx.length === 30, `GPX 기준 점이 30개여야 하는데 ${gpx.length}개`);
if (listPath) {
  const list = JSON.parse(readFileSync(listPath, 'utf8'));
  check(list.trips.length === 1, `트립이 1건이어야 하는데 ${list.trips.length}건`);
}
check(trip.pointCount === 30, `pointCount ${trip.pointCount} != 30`);
check(Array.isArray(trip.points) && trip.points.length === 30, `points.length ${trip.points?.length} != 30`);
const seqs = (trip.points ?? []).map((p) => p.seq);
check(
  seqs.every((s, i) => s === i),
  `seq가 0..29 연속이 아님: ${JSON.stringify(seqs)}`,
);
const first = trip.points?.[0];
const last = trip.points?.[29];
if (first && gpx[0])
  check(near(first.lat, gpx[0].lat, 0.0005) && near(first.lon, gpx[0].lon, 0.0005), `첫 점 좌표 불일치: ${first.lat},${first.lon}`);
if (last && gpx[29])
  check(near(last.lat, gpx[29].lat, 0.0005) && near(last.lon, gpx[29].lon, 0.0005), `끝 점 좌표 불일치: ${last.lat},${last.lon}`);
check(near(trip.distanceM, 725, 10), `distanceM ${trip.distanceM} not in 725±10`);
check(trip.durationS !== null && near(trip.durationS, 29, 3), `durationS ${trip.durationS} not in 29±3`);
check(Boolean(trip.endedAt), 'endedAt 없음');
check(
  (trip.points ?? []).every((p) => p.gear === 'D'),
  `모든 점의 gear가 D여야 함: ${JSON.stringify([...new Set((trip.points ?? []).map((p) => p.gear))])}`,
);
check(
  (trip.points ?? []).every((p) => p.speedKph === null),
  '속도를 보내면 안 됨(speedKph == null)',
);
check(trip.odometerStartKm !== null && trip.odometerStartKm !== undefined, 'odometerStartKm 없음(에뮬레이터는 0.0)');
check(typeof trip.localId === 'string' && trip.localId.length > 0, 'localId 없음');

if (failures.length > 0) {
  for (const f of failures) console.error(`검증 실패: ${f}`);
  process.exit(1);
}
console.log(
  `OK trip=${trip.tripId} localId=${trip.localId} pointCount=${trip.pointCount} distanceM=${trip.distanceM} durationS=${trip.durationS} odometer=${trip.odometerStartKm}->${trip.odometerEndKm}`,
);
