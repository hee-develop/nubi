// E2E 서버 검증: GET /trips/:id 응답(첫째 인자)을 GPX(둘째 인자)의 기준값과 대조한다. 셋째 인자는 목록 응답(트립이 1건뿐인지 확인).
// 넷째 인자는 DB 스키마(schema.ts), 다섯째는 POST /vehicles/register 응답이다. 서버가 VIN을 저장·응답하지 않는지와 차량 ID 발급(HMAC)을 확인한다.
// 실패하면 이유를 stderr에 쓰고 종료 코드 1로 끝난다.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * 1회 실측(2026-11-09, 전국 도로 DB·Valhalla 3.5.1: 세종대로 newKm 1.245, e2e-north newKm 0.163, 누적 drivenKm 1.41)에 ±10%를 둔 기대값.
 * 실제 Valhalla 응답은 결정적이다. 완료율은 분모가 도로 DB마다 달라 값 대신 drivenKm/totalKm과의 일치로 본다.
 */
const EXPECT = {
  newKm: { min: 1.12, max: 1.37 },
  drivenKm: { min: 1.27, max: 1.55 },
};

// 도로 색칠 검증 모드(사양 02 8장): verify-trip.mjs --road-coloring <trips.json> <e2e-sejong.gpx>. 서버 주소는 E2E_BASE_URL.
if (process.argv[2] === '--road-coloring') {
  await verifyRoadColoring(process.argv[3], process.argv[4]);
  process.exit(0);
}

const [detailPath, gpxPath, listPath, schemaPath, registerPath] = process.argv.slice(2);
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

// 차량 ID는 서버가 VIN으로 발급한 HMAC-SHA256(소문자 hex 64자)이어야 한다. UUID 대체(하이픈 포함)나 앱이 만든 해시가 아니다.
check(/^[0-9a-f]{64}$/.test(trip.vehicleId ?? ''), `vehicleId가 서버 발급 HMAC(hex 64자)가 아님: ${trip.vehicleId}`);
check(trip.driverId === trip.vehicleId, 'driverId가 vehicleId와 같아야 함(이번 단계)');

// 서버는 VIN을 저장·응답하지 않는다: 응답 JSON에 vin 키가 없고, DB 스키마에 vin 열이 없다.
const hasVinKey = (value) =>
  Array.isArray(value)
    ? value.some(hasVinKey)
    : value !== null && typeof value === 'object' && Object.entries(value).some(([k, v]) => /vin/i.test(k) || hasVinKey(v));
check(!hasVinKey(trip), 'GET /trips/:id 응답에 vin 키가 있음');
if (listPath) check(!hasVinKey(JSON.parse(readFileSync(listPath, 'utf8'))), 'GET /trips 응답에 vin 키가 있음');
if (schemaPath) {
  const schema = readFileSync(schemaPath, 'utf8');
  check(!/\bvin\b|vin_|_vin/i.test(schema), 'DB 스키마(schema.ts)에 vin 열이 있음');
}
const probeVin = process.env.E2E_PROBE_VIN;
if (registerPath && probeVin) {
  const reg = JSON.parse(readFileSync(registerPath, 'utf8'));
  const key = process.env.NUBI_VEHICLE_HMAC_KEY;
  // 표준 17자 형식이 아닌 VIN은 vinFormat: 'nonstandard' 표시만 추가로 허용한다(VIN 자체는 응답에 없어야 한다).
  check(
    Object.keys(reg).every((k) => k === 'vehicleId' || (k === 'vinFormat' && reg[k] === 'nonstandard')) && 'vehicleId' in reg,
    `register 응답은 vehicleId(와 vinFormat: nonstandard)만 가져야 함: ${JSON.stringify(Object.keys(reg))}`,
  );
  if (key) check(reg.vehicleId === createHmac('sha256', key).update(probeVin).digest('hex'), 'register 응답이 HMAC-SHA256(키, VIN)과 다름');
  check(!JSON.stringify(reg).includes(probeVin), 'register 응답에 VIN이 있음');
  for (const p of [detailPath, listPath].filter(Boolean)) {
    check(!readFileSync(p, 'utf8').includes(probeVin), `${p}에 등록한 VIN이 있음`);
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`검증 실패: ${f}`);
  process.exit(1);
}
console.log(
  `OK trip=${trip.tripId} localId=${trip.localId} pointCount=${trip.pointCount} distanceM=${trip.distanceM} durationS=${trip.durationS} odometer=${trip.odometerStartKm}->${trip.odometerEndKm}`,
);

/** 사양 02 8장 단언. 두 트립(e2e-north 30점, e2e-sejong 60점)을 모두 조회한다. 기대값은 1회 실측 후 ±10%로 고정한다. */
async function verifyRoadColoring(listFile, sejongGpx) {
  const base = process.env.E2E_BASE_URL;
  const fails = [];
  const ok = (cond, msg) => {
    if (!cond) fails.push(msg);
  };
  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };
  const trips = JSON.parse(readFileSync(listFile, 'utf8')).trips;
  ok(trips.length === 2, `트립이 2건이어야 하는데 ${trips.length}건`);
  const north = trips.find((t) => t.pointCount === 30);
  const sejong = trips.find((t) => t.pointCount === 60);
  ok(north && sejong, `e2e-north(30점)·e2e-sejong(60점) 트립을 찾지 못함: ${JSON.stringify(trips.map((t) => t.pointCount))}`);
  if (!north || !sejong) return finish(fails);

  // 매칭은 종료 직후 비동기로 돈다. done이 될 때까지 최대 60초 기다린다.
  const matching = async (tripId) => {
    let last;
    for (let i = 0; i < 60; i++) {
      last = (await get(`/trips/${tripId}/matching`)).body;
      if (last.status === 'done' || (last.status === 'failed' && String(last.error).startsWith('permanent'))) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return last;
  };
  const mSejong = await matching(sejong.tripId);
  const mNorth = await matching(north.tripId);

  ok(mSejong.status === 'done', `세종대로 matching.status ${mSejong.status} != done (${mSejong.error ?? ''})`);
  ok(mSejong.result?.outcome === 'counted', `세종대로 outcome ${mSejong.result?.outcome}`);
  const newKm = mSejong.result?.newKm ?? 0;
  ok(newKm >= EXPECT.newKm.min && newKm <= EXPECT.newKm.max, `세종대로 newKm ${newKm} not in ${EXPECT.newKm.min}~${EXPECT.newKm.max}`);
  ok(Boolean(mSejong.snapshotMonth) && String(mSejong.attribution).includes('OpenStreetMap'), 'snapshotMonth·attribution 없음');
  // 첫 트립(e2e-north)은 골목에 매칭돼 새 도로가 적다. done이면 되고 newKm은 0 이상.
  ok(mNorth.status === 'done', `e2e-north matching.status ${mNorth.status} != done (${mNorth.error ?? ''})`);
  ok((mNorth.result?.newKm ?? -1) >= 0, `e2e-north newKm ${mNorth.result?.newKm}`);

  const v = encodeURIComponent(sejong.vehicleId);
  const roads = (await get(`/coverage/roads?vehicleId=${v}&q=${encodeURIComponent('세종대로')}&limit=50`)).body;
  const nr31 = (roads.items ?? []).find((r) => r.roadKey === 'nr:31');
  ok(Boolean(nr31), `coverage/roads?q=세종대로에 nr:31이 없음: ${JSON.stringify((roads.items ?? []).map((r) => r.roadKey))}`);
  ok(nr31?.names?.includes('세종대로'), `nr:31 names에 세종대로가 없음: ${JSON.stringify(nr31?.names)}`);
  const summary = (await get(`/coverage/summary?vehicleId=${v}`)).body;
  ok(summary.nationalPercent > 0, `nationalPercent ${summary.nationalPercent} <= 0`);
  ok(
    summary.drivenKm >= EXPECT.drivenKm.min && summary.drivenKm <= EXPECT.drivenKm.max,
    `drivenKm ${summary.drivenKm} not in ${EXPECT.drivenKm.min}~${EXPECT.drivenKm.max}`,
  );
  const pct = (summary.drivenKm / summary.totalKm) * 100;
  ok(
    Math.abs(summary.nationalPercent - pct) <= pct * 0.01 + 0.00006,
    `nationalPercent ${summary.nationalPercent} != drivenKm/totalKm ${pct}`,
  );
  ok(summary.roadsStarted >= 1, `roadsStarted ${summary.roadsStarted}`);

  const pts = [...readFileSync(sejongGpx, 'utf8').matchAll(/<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
  const lats = pts.map((p) => p[0]);
  const lons = pts.map((p) => p[1]);
  const pad = 0.002;
  const bbox = [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad].join(',');
  const seg = (await get(`/coverage/segments?vehicleId=${v}&bbox=${bbox}`)).body;
  ok((seg.features ?? []).length >= 5, `segments feature ${(seg.features ?? []).length} < 5`);

  const ms = Date.parse(mSejong.finishedAt) - Date.parse(mSejong.startedAt);
  console.log(
    `MEASURED newKm=${newKm} nationalPercent=${summary.nationalPercent} matchingMs=${ms} segments=${(seg.features ?? []).length} roadsStarted=${summary.roadsStarted} northNewKm=${mNorth.result?.newKm} snapshot=${summary.snapshotMonth} totalKm=${summary.totalKm}`,
  );
  finish(fails);
}

function finish(fails) {
  if (fails.length > 0) {
    for (const f of fails) console.error(`검증 실패: ${f}`);
    process.exit(1);
  }
  console.log('OK road-coloring');
}
