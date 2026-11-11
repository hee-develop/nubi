import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/index.js";
import { pointInMulti, pointInRing } from "../src/regions/index.js";
import { regionDisplayName } from "../src/shared/geo-utils.mjs";
import { thinSamples } from "../src/regions/judge.js";
import {
  fakeValhalla,
  getJson,
  json,
  newApp,
  REGIONS_TEST_DB,
  ROADS_TEST_DB,
  type TestApp,
} from "./helpers.js";

const tmp = () => mkdtempSync(join(tmpdir(), "nubi-regions-"));
const NATIONAL = new URL("../data/regions/regions.sqlite", import.meta.url)
  .pathname;

type R = {
  code: string;
  name: string;
  /** 표시 이름(생략하면 name). */
  display?: string;
  sido: string;
  sidoName: string;
  rect: [number, number, number, number];
  d89?: boolean;
  d92?: boolean;
};
/** 직사각형 시군구만 담은 합성 지역 DB(스키마는 scripts/build-regions.mjs와 같다). */
const makeRegionsDb = (
  path: string,
  regions: R[],
  alias: [string, string][] = [],
) => {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE regions(code TEXT PRIMARY KEY, sido_code TEXT NOT NULL, name TEXT NOT NULL, display_name TEXT NOT NULL, sido_name TEXT NOT NULL,
      depop_89 INTEGER NOT NULL DEFAULT 0, depop_92 INTEGER NOT NULL DEFAULT 0, area_km2 REAL NOT NULL, polygons INTEGER NOT NULL,
      minlon REAL, minlat REAL, maxlon REAL, maxlat REAL, geom_json TEXT NOT NULL);
    CREATE VIRTUAL TABLE regions_rtree USING rtree(region_id, minlon, maxlon, minlat, maxlat);
    CREATE TABLE region_alias(old_code TEXT PRIMARY KEY, new_code TEXT NOT NULL, new_name TEXT NOT NULL, new_sido_code TEXT NOT NULL, new_sido_name TEXT NOT NULL);
    CREATE TABLE snapshot(month TEXT PRIMARY KEY, built_at TEXT NOT NULL, source_name TEXT NOT NULL, region_count INTEGER NOT NULL,
      polygon_count INTEGER NOT NULL, depop_89_count INTEGER NOT NULL, depop_92_count INTEGER NOT NULL, note TEXT);`);
  for (const r of regions) {
    const [a, b, c, d] = r.rect;
    const geom = JSON.stringify({
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [a, b],
            [c, b],
            [c, d],
            [a, d],
            [a, b],
          ],
        ],
      ],
    });
    const info = db
      .prepare("INSERT INTO regions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        r.code,
        r.sido,
        r.name,
        r.display ?? r.name,
        r.sidoName,
        r.d89 ? 1 : 0,
        r.d92 || r.d89 ? 1 : 0,
        1,
        1,
        a,
        b,
        c,
        d,
        geom,
      );
    db.prepare("INSERT INTO regions_rtree VALUES (?,?,?,?,?)").run(
      Number(info.lastInsertRowid),
      a,
      c,
      b,
      d,
    );
  }
  for (const [o, n] of alias)
    db.prepare("INSERT INTO region_alias VALUES (?,?,?,?,?)").run(
      o,
      n,
      n,
      "12",
      "통합",
    );
  db.prepare("INSERT INTO snapshot VALUES ('209901','x','x',?,?,0,0,NULL)").run(
    regions.length,
    regions.length,
  );
  db.close();
  return path;
};

// A 중앙, B 동(경계 공유), D 북(경계 공유, 안 가 봄), E 서(경계 공유, 인구감소지역), F 동쪽 약 200m 떨어짐(이웃 아님), C 멀리.
const LAYOUT: R[] = [
  {
    code: "11111",
    name: "A구",
    sido: "11",
    sidoName: "가시",
    rect: [127.0, 37.0, 127.1, 37.1],
  },
  {
    code: "11112",
    name: "B구",
    sido: "11",
    sidoName: "가시",
    rect: [127.1, 37.0, 127.2, 37.1],
  },
  {
    code: "11113",
    name: "C군",
    sido: "11",
    sidoName: "가시",
    rect: [128.0, 37.0, 128.1, 37.1],
    d89: true,
  },
  {
    code: "11114",
    name: "D구",
    sido: "11",
    sidoName: "가시",
    rect: [127.0, 37.1, 127.1, 37.2],
  },
  {
    code: "11115",
    name: "E군",
    sido: "11",
    sidoName: "가시",
    rect: [126.9, 37.0, 127.0, 37.1],
    d89: true,
  },
  {
    code: "11116",
    name: "F구",
    sido: "11",
    sidoName: "가시",
    rect: [127.2022, 37.0, 127.3, 37.1],
    d92: true,
  },
];
const IN = {
  A: [127.05, 37.05],
  B: [127.15, 37.05],
  C: [128.05, 37.05],
  D: [127.05, 37.15],
  E: [126.95, 37.05],
} as const;

/** 테스트 시계: 기본은 모든 테스트 트립보다 이른 시각(2026-11-08)이라 서버 now 때문에 pending이 만료되지 않는다. */
const CLOCK0 = Date.parse("2026-11-08T00:00:00Z");
const regionsApp = (
  extra: {
    alias?: [string, string][];
    db?: ReturnType<typeof openDb>;
    layout?: R[];
    clock?: { t: number };
  } = {},
) => {
  const path = makeRegionsDb(
    join(tmp(), "r.sqlite"),
    extra.layout ?? LAYOUT,
    extra.alias,
  );
  const clock = extra.clock ?? { t: CLOCK0 };
  return createApp(extra.db ?? openDb(":memory:"), {
    vehicleHmacKey: "k",
    retryDelayMs: 5,
    roadsPath: ROADS_TEST_DB,
    regionsPath: path,
    now: () => clock.t,
  });
};

const ms = (iso: string) => Date.parse(iso);
const iso = (base: string, plusMin = 0) =>
  new Date(ms(base) + plusMin * 60_000).toISOString();

/** 점이 20개 미만이라 맵매칭은 too_short로 끝나고 시군구 판정만 한다. 각 점은 [lon, lat], 1초 간격. */
const trip = async (
  app: TestApp,
  vehicleId: string,
  startAt: string,
  pts: (readonly [number, number])[],
  opts: { end?: boolean } = {},
) => {
  const start = await app.request(
    "/trips",
    json({
      localId: crypto.randomUUID(),
      vehicleId,
      driverId: vehicleId,
      startedAt: startAt,
    }),
  );
  const { tripId } = (await start.json()) as { tripId: string };
  const points = pts
    .map(([lon, lat], seq) => ({
      seq,
      ts: iso(startAt, 0).replace(/\.\d+Z$/, "") + ".000Z",
      lat,
      lon,
    }))
    .map((p, i) => ({
      ...p,
      ts: new Date(ms(startAt) + i * 1000).toISOString(),
    }));
  await app.request(`/trips/${tripId}/points`, json({ points }));
  if (opts.end !== false) {
    await app.request(
      `/trips/${tripId}/end`,
      json({ endedAt: points.at(-1)!.ts, odometerEndKm: null }),
    );
    await app.matching.idle();
  }
  return { tripId, endedAt: points.at(-1)!.ts };
};
const level = async (app: TestApp, v: string, code: string) =>
  (
    (await getJson(app, `/regions/list?vehicleId=${v}`)).body.items as {
      code: string;
      level: number;
    }[]
  ).find((i) => i.code === code)!.level;

describe("point-in-polygon", () => {
  const sq = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];
  const hole = [
    [4, 4],
    [6, 4],
    [6, 6],
    [4, 6],
    [4, 4],
  ];
  it("고리 안·밖, 구멍(도넛)과 MultiPolygon any", () => {
    expect(pointInRing(5, 5, sq)).toBe(true);
    expect(pointInRing(11, 5, sq)).toBe(false);
    expect(pointInMulti(5, 5, [[sq]])).toBe(true);
    expect(pointInMulti(5, 5, [[sq, hole]])).toBe(false); // 구멍 안은 밖
    expect(pointInMulti(2, 2, [[sq, hole]])).toBe(true);
    const far = [
      [20, 20],
      [30, 20],
      [30, 30],
      [20, 30],
      [20, 20],
    ];
    expect(pointInMulti(25, 25, [[sq, hole], [far]])).toBe(true);
    expect(pointInMulti(15, 15, [[sq, hole], [far]])).toBe(false);
  });
  it("경계 바로 안쪽·바깥쪽 점을 가른다(미세 오차 1e-9도)", () => {
    expect(pointInRing(10 - 1e-9, 5, sq)).toBe(true);
    expect(pointInRing(10 + 1e-9, 5, sq)).toBe(false);
    expect(pointInRing(5, 1e-9, sq)).toBe(true);
    expect(pointInRing(5, -1e-9, sq)).toBe(false);
  });
  it("실제 픽스처: 세종대로 첫 점은 종로구, 끝 점은 중구", async () => {
    const app = newApp();
    const { body } = await getJson(
      app,
      "/regions/geo?vehicleId=v&bbox=126.9,37.5,127.1,37.6",
    );
    const byCode = Object.fromEntries(
      body.features.map((f: any) => [
        f.properties.code,
        f.geometry.coordinates,
      ]),
    );
    expect(pointInMulti(126.977065, 37.575162, byCode["11110"])).toBe(true);
    expect(pointInMulti(126.977065, 37.575162, byCode["11140"])).toBe(false);
    expect(pointInMulti(126.976073, 37.562023, byCode["11140"])).toBe(true);
  });
});

describe("표본 솎기", () => {
  it("200m 간격으로 솎고 처음·끝은 항상 남기며 상한을 넘으면 균등하게 줄인다", () => {
    const pts = Array.from({ length: 101 }, (_, i) => ({
      lat: 37 + (i * 25) / 111_195,
      lon: 127,
      ts: String(i),
    }));
    const t = thinSamples(pts);
    expect(t[0]).toBe(pts[0]);
    expect(t.at(-1)).toBe(pts.at(-1));
    expect(t.length).toBeGreaterThanOrEqual(12);
    expect(t.length).toBeLessThanOrEqual(14); // 2,500m / 200m
    const many = Array.from({ length: 10_000 }, (_, i) => ({
      lat: 37 + (i * 250) / 111_195,
      lon: 127,
      ts: String(i),
    }));
    const capped = thinSamples(many);
    expect(capped.length).toBe(2_000);
    expect(capped.at(-1)).toBe(many.at(-1));
  });
});

describe("판정: 통과", () => {
  it("통과는 level 1이고 처음 지난 시군구만 newPassed에 담긴다", async () => {
    const app = regionsApp();
    const t1 = await trip(app, "v1", "2026-11-09T01:00:00Z", [IN.A, IN.B]);
    const m1 = (await getJson(app, `/trips/${t1.tripId}/matching`)).body;
    expect(m1.status).toBe("done");
    expect(m1.result.regions).toMatchObject({
      passed: ["11111", "11112"],
      newPassed: ["11111", "11112"],
      newPassedNames: ["A구", "B구"],
      visitPending: "11112",
    });
    const t2 = await trip(app, "v1", "2026-11-09T01:05:00Z", [IN.A, IN.D]);
    const m2 = (await getJson(app, `/trips/${t2.tripId}/matching`)).body;
    expect(m2.result.regions).toMatchObject({
      passed: ["11111", "11114"],
      newPassed: ["11114"],
    });
    const s = (await getJson(app, "/regions/summary?vehicleId=v1")).body;
    expect(s).toMatchObject({
      total: 6,
      colored: 3,
      byLevel: { "1": 3, "2": 0, "3": 0 },
    });
    // 다른 차량의 기록과 섞이지 않는다
    expect(
      (await getJson(app, "/regions/summary?vehicleId=other")).body.colored,
    ).toBe(0);
  });

  it("시군구 밖에서 끝난 트립은 pending이 없고 passed도 비어 있다", async () => {
    const app = regionsApp();
    const t = await trip(app, "v1", "2026-11-09T01:00:00Z", [
      [120, 30],
      [120.001, 30],
    ]);
    expect(
      (await getJson(app, `/trips/${t.tripId}/matching`)).body.result.regions,
    ).toMatchObject({
      passed: [],
      newPassed: [],
      visitPending: null,
    });
  });
});

describe("판정: 방문·숙박", () => {
  const T0 = "2026-11-09T01:00:00Z"; // KST 10:00

  it("간격 10분 미만은 방문이 아니고 정확히 10분이면 방문(level 2)", async () => {
    const app = regionsApp();
    const a = await trip(app, "gap9", T0, [IN.A, IN.A]);
    await trip(app, "gap9", iso(a.endedAt, 9), [IN.A, IN.A]);
    expect(await level(app, "gap9", "11111")).toBe(1);
    const b = await trip(app, "gap10", T0, [IN.A, IN.A]);
    await trip(app, "gap10", iso(b.endedAt, 10), [IN.A, IN.A]);
    expect(await level(app, "gap10", "11111")).toBe(2);
    const s = (await getJson(app, "/regions/summary?vehicleId=gap10")).body;
    expect(s.byLevel).toEqual({ "1": 0, "2": 1, "3": 0 });
    expect(s.lastEvent).toMatchObject({
      kind: "visit",
      code: "11111",
      name: "A구",
    });
  });

  it("방문은 다음 트립 Start 시점에 확정되고(Start만으로 반영), 종료 지점이 아닌 시군구는 통과로 남는다", async () => {
    const app = regionsApp();
    const a = await trip(app, "v", T0, [IN.A, IN.B]); // B에서 종료
    await app.request(
      "/trips",
      json({
        localId: "next",
        vehicleId: "v",
        driverId: "v",
        startedAt: iso(a.endedAt, 30),
      }),
    );
    expect(await level(app, "v", "11112")).toBe(2);
    expect(await level(app, "v", "11111")).toBe(1);
  });

  it("숙박: 6시간 이상 + 자정(KST) 통과 + 같은 시군구에서 시작(첫 점이 올라온 뒤 확정)", async () => {
    const app = regionsApp();
    const a = await trip(app, "v", "2026-11-09T12:00:00Z", [IN.A, IN.A]); // KST 21:00
    // 다음 날 06:00 KST(+9h)
    const startAt = iso(a.endedAt, 9 * 60);
    await app.request(
      "/trips",
      json({ localId: "n", vehicleId: "v", driverId: "v", startedAt: startAt }),
    );
    expect(await level(app, "v", "11111")).toBe(2); // Start 직후는 방문, 시작 지점을 아직 모른다
    const tripId = (
      (await getJson(app, "/trips?vehicleId=v")).body.trips as {
        tripId: string;
        localId: string;
      }[]
    ).find((t) => t.localId === "n")!.tripId;
    await app.request(
      `/trips/${tripId}/points`,
      json({ points: [{ seq: 0, ts: startAt, lat: IN.A[1], lon: IN.A[0] }] }),
    );
    expect(await level(app, "v", "11111")).toBe(3);
    const s = (await getJson(app, "/regions/summary?vehicleId=v")).body;
    expect(s.lastEvent).toMatchObject({ kind: "stay", code: "11111" });
    expect(s.byLevel).toEqual({ "1": 0, "2": 0, "3": 1 });
  });

  it("숙박 아님: 자정을 안 넘긴 6시간·자정을 넘긴 5시간 59분·다른 시군구에서 시작", async () => {
    const app = regionsApp();
    // 6시간 이상이지만 자정(KST)을 안 지남: 01:00Z(10:00 KST) → 08:00Z(17:00 KST)
    const a = await trip(app, "noMidnight", "2026-11-09T01:00:00Z", [
      IN.A,
      IN.A,
    ]);
    await trip(app, "noMidnight", iso(a.endedAt, 7 * 60), [IN.A, IN.A]);
    expect(await level(app, "noMidnight", "11111")).toBe(2);
    // 자정을 지났지만 6시간 미만: 14:00Z(23:00 KST) → 19:59Z(04:59 KST)
    const b = await trip(app, "short", "2026-11-09T14:00:00Z", [IN.A, IN.A]);
    await trip(app, "short", iso(b.endedAt, 5 * 60 + 59), [IN.A, IN.A]);
    expect(await level(app, "short", "11111")).toBe(2);
    // 다른 시군구에서 시작: 방문만
    const c = await trip(app, "other", "2026-11-09T12:00:00Z", [IN.A, IN.A]);
    await trip(app, "other", iso(c.endedAt, 9 * 60), [IN.B, IN.B]);
    expect(await level(app, "other", "11111")).toBe(2);
    expect(await level(app, "other", "11112")).toBe(1);
  });

  it("단계는 내려가지 않는다: 숙박(3) 뒤 짧은 간격 방문·통과가 와도 3", async () => {
    const app = regionsApp();
    const a = await trip(app, "v", "2026-11-09T12:00:00Z", [IN.A, IN.A]);
    const b = await trip(app, "v", iso(a.endedAt, 9 * 60), [IN.A, IN.A]);
    expect(await level(app, "v", "11111")).toBe(3);
    await trip(app, "v", iso(b.endedAt, 11), [IN.A, IN.A]); // 방문 간격
    await trip(app, "v", iso(b.endedAt, 60), [IN.A, IN.B]); // 통과
    expect(await level(app, "v", "11111")).toBe(3);
  });

  it("24시간 배치: 다음 트립이 안 오면 24시간 뒤 방문으로 확정, 그 전에는 그대로", async () => {
    const app = regionsApp();
    const a = await trip(app, "v", T0, [IN.C, IN.C]);
    expect(app.regionsBatch(ms(a.endedAt) + 23 * 3_600_000)).toBe(0);
    expect(await level(app, "v", "11113")).toBe(1);
    expect(app.regionsBatch(ms(a.endedAt) + 24 * 3_600_000 + 1)).toBe(1);
    expect(await level(app, "v", "11113")).toBe(2);
    expect(
      (await getJson(app, "/regions/summary?vehicleId=v")).body.lastEvent,
    ).toMatchObject({ kind: "visit", code: "11113" });
    expect(app.regionsBatch(ms(a.endedAt) + 48 * 3_600_000)).toBe(0); // 멱등
  });

  it("매칭이 늦어도(다음 트립이 먼저 시작) 판정이 빠지지 않는다", async () => {
    const app = regionsApp();
    const a = await trip(app, "v", T0, [IN.A, IN.A], { end: false });
    // 다음 트립 Start가 먼저 도착
    await app.request(
      "/trips",
      json({
        localId: "x",
        vehicleId: "v",
        driverId: "v",
        startedAt: iso(T0, 60),
      }),
    );
    await app.request(
      `/trips/${a.tripId}/end`,
      json({ endedAt: a.endedAt, odometerEndKm: null }),
    );
    await app.matching.idle();
    expect(await level(app, "v", "11111")).toBe(2);
  });
});

describe("통합특별시 alias 합산", () => {
  it("옛 코드로 쌓인 기록은 새 코드로 합산된다(단계 최댓값·횟수 합·시각 min/max)", async () => {
    const db = openDb(":memory:");
    const ins = db.prepare(
      "INSERT INTO visited_regions VALUES (?,?,?,?,?,?,?,?)",
    );
    ins.run(
      "v1",
      "99999",
      3,
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      2,
      1,
      1,
    );
    ins.run(
      "v1",
      "11113",
      1,
      "2026-03-01T00:00:00Z",
      "2026-03-02T00:00:00Z",
      1,
      0,
      0,
    );
    ins.run(
      "v2",
      "99999",
      2,
      "2026-01-05T00:00:00Z",
      "2026-01-06T00:00:00Z",
      1,
      1,
      0,
    );
    db.prepare(
      "INSERT INTO region_pending VALUES ('t1','v1','99999','2026-04-01T00:00:00Z',0)",
    ).run();
    const app = regionsApp({ alias: [["99999", "11113"]], db });
    const rows = db
      .prepare("SELECT * FROM visited_regions ORDER BY vehicle_id, code")
      .all();
    expect(rows).toEqual([
      {
        vehicle_id: "v1",
        code: "11113",
        level: 3,
        first_at: "2026-01-01T00:00:00Z",
        last_at: "2026-03-02T00:00:00Z",
        passes: 3,
        visits: 1,
        stays: 1,
      },
      {
        vehicle_id: "v2",
        code: "11113",
        level: 2,
        first_at: "2026-01-05T00:00:00Z",
        last_at: "2026-01-06T00:00:00Z",
        passes: 1,
        visits: 1,
        stays: 0,
      },
    ]);
    expect(db.prepare("SELECT code FROM region_pending").get()).toEqual({
      code: "11113",
    });
    expect(await level(app, "v1", "11113")).toBe(3);
  });
});

describe("조회 API", () => {
  it("summary: 도감 분모·인구감소지역(89/92) 집계와 byLevel", async () => {
    const app = regionsApp();
    await trip(app, "v", "2026-11-09T01:00:00Z", [IN.C, IN.C]);
    const s = (await getJson(app, "/regions/summary?vehicleId=v")).body;
    // C군은 89·92 모두, F구는 92만(신규 편입), E군은 89·92
    expect(s).toMatchObject({
      total: 6,
      colored: 1,
      depop: { total: 3, colored: 1, total89: 2, colored89: 1 },
    });
    expect(s.depop).not.toHaveProperty("total92"); // 92가 기본(total), 89는 참고 필드
    expect(s.attribution).toContain("vuski/admdongkor");
    expect(s.snapshotMonth).toBe("209901");
    expect((await getJson(app, "/regions/summary")).status).toBe(400);
  });

  it("list: filter·sort", async () => {
    const app = regionsApp();
    await trip(app, "v", "2026-11-09T01:00:00Z", [IN.A, IN.A]);
    await trip(app, "v", "2026-11-09T03:00:00Z", [IN.C, IN.C]);
    const get = async (qs: string) =>
      (
        (await getJson(app, `/regions/list?vehicleId=v&${qs}`)).body
          .items as any[]
      ).map((i) => i.code);
    expect(await get("filter=all&sort=name")).toEqual([
      "11111",
      "11112",
      "11113",
      "11114",
      "11115",
      "11116",
    ]);
    expect(await get("filter=depop")).toEqual(["11113", "11115", "11116"]);
    expect(await get("filter=uncolored")).toEqual([
      "11112",
      "11114",
      "11115",
      "11116",
    ]);
    expect((await get("sort=recent")).slice(0, 2)).toEqual(["11113", "11111"]); // 최근 지난 순, 미방문은 뒤
    expect(
      (await getJson(app, "/regions/list?vehicleId=v&filter=x")).status,
    ).toBe(400);
    const c = (
      (await getJson(app, "/regions/list?vehicleId=v")).body.items as any[]
    ).find((i) => i.code === "11113");
    expect(c).toMatchObject({
      name: "C군",
      sidoName: "가시",
      level: 1,
      depop89: true,
      depop92: true,
    });
    expect(c.firstAt).toBeTruthy();
  });

  it("geo: bbox 검증(한 변 ≤ 3°)·GeoJSON·level 속성", async () => {
    const app = regionsApp();
    await trip(app, "v", "2026-11-09T01:00:00Z", [IN.A, IN.A]);
    const ok = (
      await getJson(
        app,
        "/regions/geo?vehicleId=v&bbox=126.95,37.0,127.15,37.1",
      )
    ).body;
    expect(ok.type).toBe("FeatureCollection");
    const props = Object.fromEntries(
      ok.features.map((f: any) => [f.properties.code, f.properties]),
    );
    expect(props["11111"]).toEqual({
      code: "11111",
      name: "A구",
      displayName: "A구",
      level: 1,
      depop89: false,
    });
    expect(props["11115"].depop89).toBe(true);
    expect(ok.features[0].geometry.type).toBe("MultiPolygon");
    expect(ok.attribution).toContain("CC BY 4.0");
    expect(
      (await getJson(app, "/regions/geo?vehicleId=v&bbox=120,30,123.1,31"))
        .status,
    ).toBe(400); // 경도 3.1°
    expect(
      (await getJson(app, "/regions/geo?vehicleId=v&bbox=120,30,123,33"))
        .status,
    ).toBe(200); // 정확히 3°
    expect(
      (await getJson(app, "/regions/geo?vehicleId=v&bbox=bad")).status,
    ).toBe(400);
  });

  it("neighbors: 경계 공유(50m 미만)만, 안 가 본 곳 → 인구감소지역 → 이름 순", async () => {
    const app = regionsApp();
    await trip(app, "v", "2026-11-09T01:00:00Z", [IN.B, IN.B]); // B는 이미 칠함
    const body = (
      await getJson(app, "/regions/neighbors?code=11111&vehicleId=v")
    ).body;
    // A의 이웃: B(동, 칠함), D(북), E(서, 인구감소). F는 B 너머라 아님.
    expect(body.items.map((i: any) => i.code)).toEqual([
      "11115",
      "11114",
      "11112",
    ]);
    expect(body.items[0]).toMatchObject({
      name: "E군",
      level: 0,
      depop89: true,
      distanceM: 0,
    });
    expect(body.items[2].level).toBe(1);
    // B의 이웃: A(변 공유)와 D(꼭짓점만 닿음). F는 약 200m 떨어져 있어 이웃이 아니다
    const b = (await getJson(app, "/regions/neighbors?code=11112")).body;
    expect(b.items.map((i: any) => i.code)).toEqual(["11111", "11114"]);
    expect(body.attribution).toBeTruthy();
    expect((await getJson(app, "/regions/neighbors?code=00000")).status).toBe(
      404,
    );
    expect((await getJson(app, "/regions/neighbors")).status).toBe(400);
  });
});

describe("지역 DB 없음(사양 03 S2: 매칭과 분리)", () => {
  it("지역 API는 503이고, 매칭은 done으로 끝나며 지역 판정만 region_jobs로 재시도 대기(regions: pending)", async () => {
    const db = openDb(":memory:");
    const app = createApp(db, {
      vehicleHmacKey: "k",
      roadsPath: ROADS_TEST_DB,
      regionsPath: null,
      retryDelayMs: 60_000,
      valhalla: {
        fetchFn: fakeValhalla(() => ({ edges: [], matched_points: [] })),
      },
    });
    for (const path of [
      "/regions/summary?vehicleId=v",
      "/regions/list?vehicleId=v",
      "/regions/geo?bbox=1,1,2,2",
      "/regions/neighbors?code=11110",
    ]) {
      const r = await getJson(app as unknown as TestApp, path);
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({
        error: "regions_db_unavailable",
        snapshotMonth: null,
      });
      expect(r.body.attribution).toContain("SGIS");
    }
    const t = await trip(
      app as unknown as TestApp,
      "v",
      "2026-11-09T01:00:00Z",
      [IN.A, IN.A],
      { end: true },
    );
    const m = (
      await getJson(app as unknown as TestApp, `/trips/${t.tripId}/matching`)
    ).body;
    expect(m).toMatchObject({
      status: "done",
      result: { outcome: "skipped", regions: "pending" },
    });
    expect(
      db
        .prepare("SELECT status, attempts FROM region_jobs WHERE trip_id = ?")
        .get(t.tripId),
    ).toEqual({
      status: "queued",
      attempts: 1,
    });
    app.matching.stop();
  });

  it("나중에 지역 DB가 붙으면(재시작) 쌓인 작업이 끝나고 result.regions가 결과로 바뀐다", async () => {
    const file = join(tmp(), "n.sqlite");
    const db1 = openDb(file);
    const app1 = createApp(db1, {
      vehicleHmacKey: "k",
      roadsPath: ROADS_TEST_DB,
      regionsPath: null,
      retryDelayMs: 60_000,
    });
    const t = await trip(
      app1 as unknown as TestApp,
      "v",
      "2026-11-09T01:00:00Z",
      [IN.A, IN.B],
    );
    app1.matching.stop();
    const app2 = regionsApp({ db: openDb(file) });
    (app2 as unknown as { matching: { start: () => void } }).matching.start();
    const m = (
      await getJson(app2 as unknown as TestApp, `/trips/${t.tripId}/matching`)
    ).body;
    expect(m.result.regions).toMatchObject({
      passed: ["11111", "11112"],
      newPassedNames: ["A구", "B구"],
    });
    expect(await level(app2 as unknown as TestApp, "v", "11112")).toBe(1);
    app2.matching.stop();
  });
});

describe.skipIf(!existsSync(NATIONAL))(
  "전국 지역 DB(server/data/regions/regions.sqlite)",
  () => {
    it("도감 분모 229·인구감소지역 89/92, 세종대로 점은 종로구·중구", async () => {
      const app = createApp(openDb(":memory:"), {
        vehicleHmacKey: "k",
        roadsPath: ROADS_TEST_DB,
        regionsPath: NATIONAL,
      });
      const s = (await getJson(app, "/regions/summary?vehicleId=none")).body;
      expect(s).toMatchObject({
        total: 229,
        colored: 0,
        depop: { total: 92, colored: 0, total89: 89, colored89: 0 },
      });
      const wrap = app as unknown as TestApp;
      const t = await trip(wrap, "v", "2026-11-09T01:00:00Z", [
        [126.977065, 37.575162],
        [126.976073, 37.562023],
      ]);
      expect(
        (await getJson(wrap, `/trips/${t.tripId}/matching`)).body.result.regions
          .newPassedNames,
      ).toEqual(["서울 종로구", "서울 중구"]);
      // 종로구의 이웃에는 중구가 들어가고, 이웃 목록은 안 가 본 곳이 먼저다(종로구·중구는 방금 칠함 → 뒤로)
      const n = (
        await getJson(wrap, "/regions/neighbors?code=11110&vehicleId=v")
      ).body.items as { code: string; level: number }[];
      expect(n.map((i) => i.code)).toContain("11140");
      expect(n.findIndex((i) => i.level > 0)).toBeGreaterThan(
        n.findIndex((i) => i.level === 0),
      );
      // 통합특별시: 광주 동구(옛 29110)는 새 코드 12210
      const g = (await getJson(wrap, "/regions/list?vehicleId=v")).body
        .items as { code: string; sidoName: string }[];
      expect(g.find((i) => i.code === "12210")?.sidoName).toBe(
        "전남광주통합특별시",
      );
    });
  },
);

describe("픽스처", () => {
  it("regions-test.sqlite는 종로·중·용산·성동 + 홍천·양구·인제를 담는다", async () => {
    const app = newApp();
    const s = (await getJson(app, "/regions/summary?vehicleId=v")).body;
    expect(s).toMatchObject({ total: 7, depop: { total: 2, total89: 2 } });
    expect(REGIONS_TEST_DB).toContain("regions-test.sqlite");
  });
});

const H = 3_600_000;
const DAY = 24 * H;
const tripAt = async (
  app: TestApp,
  v: string,
  startMs: number,
  pts: (readonly [number, number])[] = [IN.A, IN.A],
  opts: { end?: boolean } = {},
) => trip(app, v, new Date(startMs).toISOString(), pts, opts);

describe("S1: 숙박·배치 규칙(업로드 시점과 무관한 같은 결과)", () => {
  const A_START = Date.parse("2026-11-09T12:00:00Z"); // KST 21:00, 종료 1초 뒤
  const events = (db: ReturnType<typeof openDb>, v: string) =>
    db
      .prepare(
        "SELECT kind, code FROM region_events WHERE vehicle_id = ? AND kind != ? ORDER BY kind",
      )
      .all(v, "pass");
  const counts = (db: ReturnType<typeof openDb>, v: string, code: string) =>
    db
      .prepare(
        "SELECT level, visits, stays FROM visited_regions WHERE vehicle_id = ? AND code = ?",
      )
      .get(v, code);

  it("36시간 뒤 같은 시군구에서 시작: End를 즉시 올려도, 지연해서 올려도 숙박이다", async () => {
    // 즉시: A 종료·매칭 → 36시간 뒤 Start + 첫 점
    const db1 = openDb(":memory:");
    const clock = { t: CLOCK0 };
    const app1 = regionsApp({ db: db1, clock }) as unknown as TestApp;
    const a1 = await tripAt(app1, "v", A_START);
    clock.t = ms(a1.endedAt) + 36 * H;
    await tripAt(app1, "v", clock.t);
    // 지연: 두 트립의 점이 먼저 올라오고 A의 End는 한참 뒤(24시간 배치가 이미 지난 뒤)에 도착
    const db2 = openDb(":memory:");
    const clock2 = { t: CLOCK0 };
    const app2 = regionsApp({
      db: db2,
      clock: clock2,
    }) as unknown as TestApp & { regionsBatch: (n: number) => number };
    const a2 = await tripAt(app2, "v", A_START, [IN.A, IN.A], { end: false });
    clock2.t = ms(a2.endedAt) + 36 * H;
    await tripAt(app2, "v", clock2.t);
    await app2.request(
      `/trips/${a2.tripId}/end`,
      json({ endedAt: a2.endedAt, odometerEndKm: null }),
    );
    await app2.matching.idle();
    for (const db of [db1, db2]) {
      expect(counts(db, "v", "11111")).toEqual({
        level: 3,
        visits: 1,
        stays: 1,
      });
      expect(events(db, "v")).toEqual([
        { kind: "stay", code: "11111" },
        { kind: "visit", code: "11111" },
      ]);
    }
  });

  it("24시간 배치가 잠정 방문을 확정한 뒤에 늦게 온 Start·첫 점으로 숙박 승격", async () => {
    const db = openDb(":memory:");
    const clock = { t: CLOCK0 };
    const app = regionsApp({ db, clock }) as unknown as TestApp & {
      regionsBatch: (n: number) => number;
    };
    const a = await tripAt(app, "v", A_START);
    expect(app.regionsBatch(ms(a.endedAt) + 25 * H)).toBe(1); // 잠정 방문
    expect(counts(db, "v", "11111")).toEqual({ level: 2, visits: 1, stays: 0 });
    expect(db.prepare("SELECT visit_done FROM region_pending").get()).toEqual({
      visit_done: 1,
    }); // 7일 보존
    clock.t = ms(a.endedAt) + 36 * H;
    await tripAt(app, "v", clock.t);
    expect(counts(db, "v", "11111")).toEqual({ level: 3, visits: 1, stays: 1 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM region_pending WHERE trip_id = ?")
        .get(a.tripId),
    ).toEqual({ n: 0 });
  });

  it("5분 간격인데 Start가 하루 늦게 도착: 잠정 방문이 취소된다(방문 아님)", async () => {
    const db = openDb(":memory:");
    const clock = { t: CLOCK0 };
    const app = regionsApp({ db, clock }) as unknown as TestApp & {
      regionsBatch: (n: number) => number;
    };
    const a = await tripAt(app, "v", A_START);
    expect(app.regionsBatch(ms(a.endedAt) + 25 * H)).toBe(1);
    expect(counts(db, "v", "11111")).toEqual({ level: 2, visits: 1, stays: 0 });
    clock.t = ms(a.endedAt) + 26 * H;
    await tripAt(app, "v", ms(a.endedAt) + 5 * 60_000); // 5분 뒤 시작한 트립이 하루 늦게 업로드
    // A의 방문은 취소됐다(남은 방문 1회는 늦게 올라온 그 트립 자신의 종료 지점 — 24시간이 지나 잠정 방문)
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM region_events WHERE trip_id = ?")
        .get(a.tripId),
    ).toEqual({ n: 1 }); // 통과(pass)만
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM region_events WHERE trip_id = ? AND kind = 'visit'",
        )
        .get(a.tripId),
    ).toEqual({ n: 0 });
    expect(counts(db, "v", "11111")).toEqual({ level: 2, visits: 1, stays: 0 });
  });

  it("8일 뒤 시작: 장기 주차로 보고 방문만(숙박 아님)", async () => {
    const db = openDb(":memory:");
    const clock = { t: CLOCK0 };
    const app = regionsApp({ db, clock }) as unknown as TestApp;
    const a = await tripAt(app, "v", A_START);
    clock.t = ms(a.endedAt) + 8 * DAY;
    await tripAt(app, "v", clock.t);
    expect(counts(db, "v", "11111")).toEqual({ level: 2, visits: 1, stays: 0 });
  });

  it("정확히 6시간 + 자정 통과는 숙박, 6시간 − 1초는 방문만", async () => {
    for (const [gapMs, level] of [
      [6 * H, 3],
      [6 * H - 1000, 2],
    ] as const) {
      const db = openDb(":memory:");
      const clock = { t: CLOCK0 };
      const app = regionsApp({ db, clock }) as unknown as TestApp;
      const a = await tripAt(app, "v", Date.parse("2026-11-09T14:00:00Z")); // KST 23:00, 종료 23:00:01
      clock.t = ms(a.endedAt) + gapMs; // 05:00:01 KST(자정 통과)
      await tripAt(app, "v", clock.t);
      expect(counts(db, "v", "11111"), `gap ${gapMs}`).toMatchObject({ level });
    }
  });

  it("숙박 대기 만료: 시작 지점(점)이 7일 안에 안 오면 방문만 남기고 pending을 지운다", async () => {
    const db = openDb(":memory:");
    const clock = { t: CLOCK0 };
    const app = regionsApp({ db, clock }) as unknown as TestApp & {
      regionsBatch: (n: number) => number;
    };
    const a = await tripAt(app, "v", A_START);
    await app.request(
      "/trips",
      json({
        localId: "n",
        vehicleId: "v",
        driverId: "v",
        startedAt: new Date(ms(a.endedAt) + 9 * H).toISOString(),
      }),
    );
    expect(counts(db, "v", "11111")).toEqual({ level: 2, visits: 1, stays: 0 });
    expect(app.regionsBatch(ms(a.endedAt) + 6 * DAY)).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM region_pending").get(),
    ).toEqual({ n: 1 });
    expect(app.regionsBatch(ms(a.endedAt) + 7 * DAY)).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM region_pending").get(),
    ).toEqual({ n: 0 });
    expect(counts(db, "v", "11111")).toEqual({ level: 2, visits: 1, stays: 0 });
  });

  it("다음 트립이 안 오면 7일 뒤 pending을 지운다(방문은 잠정 확정으로 남음)", async () => {
    const db = openDb(":memory:");
    const app = regionsApp({ db }) as unknown as TestApp & {
      regionsBatch: (n: number) => number;
    };
    const a = await tripAt(app, "v", A_START);
    expect(app.regionsBatch(ms(a.endedAt) + 7 * DAY)).toBe(2); // 방문 반영 + 삭제
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM region_pending").get(),
    ).toEqual({ n: 0 });
    expect(counts(db, "v", "11111")).toEqual({ level: 2, visits: 1, stays: 0 });
  });

  it("시군구 밖에서 끝난 트립 다음의 트립은 방문·숙박을 만들지 않는다", async () => {
    const db = openDb(":memory:");
    const clock = { t: CLOCK0 };
    const app = regionsApp({ db, clock }) as unknown as TestApp;
    const out = [
      [120, 30],
      [120.001, 30],
    ] as const;
    const a = await tripAt(app, "v", A_START, [IN.A, out[0], out[1]]); // A를 지나 바다에서 종료
    clock.t = ms(a.endedAt) + 9 * H;
    await tripAt(app, "v", clock.t);
    expect(counts(db, "v", "11111")).toEqual({ level: 1, visits: 0, stays: 0 });
    expect(events(db, "v")).toEqual([]);
  });

  it("suspect(오도미터 불일치) 트립은 시군구 판정에서 제외된다(작업·통과·pending 없음)", async () => {
    const db = openDb(":memory:");
    const app = regionsApp({ db }) as unknown as TestApp;
    const pts = Array.from(
      { length: 25 },
      (_, i) => [IN.A[0] + (i * (IN.B[0] - IN.A[0])) / 24, IN.A[1]] as const,
    ); // 약 9km
    const start = await app.request(
      "/trips",
      json({
        localId: "s",
        vehicleId: "v",
        driverId: "v",
        startedAt: "2026-11-09T01:00:00Z",
        odometerStartKm: 100,
      }),
    );
    const { tripId } = (await start.json()) as { tripId: string };
    const points = pts.map(([lon, lat], i) => ({
      seq: i,
      ts: new Date(Date.parse("2026-11-09T01:00:00Z") + i * 1000).toISOString(),
      lat,
      lon,
    }));
    await app.request(`/trips/${tripId}/points`, json({ points }));
    await app.request(
      `/trips/${tripId}/end`,
      json({ endedAt: points.at(-1)!.ts, odometerEndKm: 101 }),
    );
    await app.matching.idle();
    const m = (await getJson(app, `/trips/${tripId}/matching`)).body;
    expect(m.result).toMatchObject({ outcome: "suspect", suspect: true });
    expect(m.result.regions).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM region_jobs").get()).toEqual({
      n: 0,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM visited_regions").get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM region_pending").get(),
    ).toEqual({ n: 0 });
  });
});

describe("alias 정본(canonicalVehicleId)", () => {
  // 서버 발급 ID 'm-srv'에 alias가 사전순으로 앞('a-uuid')·뒤('z-uuid')인 두 경우
  for (const alias of ["a-uuid", "z-uuid"]) {
    it(`alias ${alias}로 올린 트립도 정본 'm-srv'의 칠한 기록을 기준으로 처음 지난 곳을 가린다`, async () => {
      const db = openDb(":memory:");
      db.prepare("INSERT INTO vehicle_alias VALUES (?, ?)").run(alias, "m-srv");
      const app = regionsApp({ db }) as unknown as TestApp;
      await trip(app, "m-srv", "2026-11-09T01:00:00Z", [IN.A, IN.A]); // 정본으로 A를 칠함
      const t2 = await trip(app, alias, "2026-11-09T02:00:00Z", [IN.A, IN.B]); // alias로 A·B
      const r = (await getJson(app, `/trips/${t2.tripId}/matching`)).body.result
        .regions;
      expect(r.passed).toEqual(["11111", "11112"]);
      expect(r.newPassed).toEqual(["11112"]); // A는 이미 칠해져 있다
      expect(
        (await getJson(app, "/regions/summary?vehicleId=m-srv")).body.colored,
      ).toBe(2);
      expect(
        (await getJson(app, `/regions/summary?vehicleId=${alias}`)).body
          .colored,
      ).toBe(2);
    });
  }

  it("시작 때 배치가 쌓인 pending을 정본·alias 묶음으로 재처리한다", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO vehicle_alias VALUES (?, ?)").run(
      "a-uuid",
      "m-srv",
    );
    db.prepare(
      "INSERT INTO region_pending VALUES ('t1','a-uuid','11111','2026-11-09T00:00:00.000Z',0)",
    ).run();
    db.prepare(
      "INSERT INTO region_pending VALUES ('t2','m-srv','11112','2026-11-09T00:00:00.000Z',0)",
    ).run();
    const app = regionsApp({ db }) as unknown as TestApp & {
      regionsBatch: (n: number) => number;
    };
    expect(app.regionsBatch(Date.parse("2026-11-09T00:00:00Z") + 2 * DAY)).toBe(
      2,
    );
    expect(
      db
        .prepare(
          "SELECT vehicle_id, code, level FROM visited_regions ORDER BY code",
        )
        .all(),
    ).toEqual([
      { vehicle_id: "a-uuid", code: "11111", level: 2 },
      { vehicle_id: "m-srv", code: "11112", level: 2 },
    ]);
  });
});

describe("region_events alias 병합(통합특별시)", () => {
  it("옛 코드 이벤트는 새 코드로 옮기고, 같은 키가 이미 있으면 옛 것을 버린다", () => {
    const db = openDb(":memory:");
    const ins = db.prepare(
      "INSERT INTO region_events (vehicle_id, code, kind, at, trip_id) VALUES (?,?,?,?,?)",
    );
    ins.run("v", "99999", "visit", "2026-01-01T00:00:00Z", "t1");
    ins.run("v", "99999", "stay", "2026-01-02T00:00:00Z", "t2");
    ins.run("v", "11113", "stay", "2026-01-02T00:00:00Z", "t2"); // 같은 (차량, 종류, 트립)이 새 코드에 이미 있음
    regionsApp({ alias: [["99999", "11113"]], db });
    expect(
      db
        .prepare(
          "SELECT code, kind, trip_id FROM region_events ORDER BY kind, trip_id",
        )
        .all(),
    ).toEqual([
      { code: "11113", kind: "stay", trip_id: "t2" },
      { code: "11113", kind: "visit", trip_id: "t1" },
    ]);
  });
});

describe("경계 틈·겹침 보정", () => {
  it("폴리곤 밖이어도 50m 이내면 가장 가까운 시군구로, 그 밖이면 null", async () => {
    const app = regionsApp() as unknown as TestApp;
    // B(127.1~127.2)와 F(127.2022~) 사이 틈 약 195m: B에서 44m(포함)·97m 지점(제외)
    const near = await trip(app, "gap", "2026-11-09T01:00:00Z", [
      [127.2005, 37.05],
      [127.2005, 37.05],
    ]);
    expect(
      (await getJson(app, `/trips/${near.tripId}/matching`)).body.result
        .regions,
    ).toMatchObject({
      passed: ["11112"],
      visitPending: "11112",
    });
    const far = await trip(app, "gap2", "2026-11-09T01:00:00Z", [
      [127.2011, 37.05],
      [127.2011, 37.05],
    ]);
    expect(
      (await getJson(app, `/trips/${far.tripId}/matching`)).body.result.regions,
    ).toMatchObject({ passed: [], visitPending: null });
  });

  it("폴리곤이 겹치면 code가 작은 쪽(ORDER BY code)", async () => {
    const layout: R[] = [
      {
        code: "11999",
        name: "나구",
        sido: "11",
        sidoName: "가시",
        rect: [127.0, 37.0, 127.1, 37.1],
      },
      {
        code: "11001",
        name: "가구",
        sido: "11",
        sidoName: "가시",
        rect: [127.05, 37.0, 127.15, 37.1],
      },
    ];
    const app = regionsApp({ layout }) as unknown as TestApp;
    const t = await trip(app, "v", "2026-11-09T01:00:00Z", [
      [127.07, 37.05],
      [127.07, 37.05],
    ]); // 겹침 구간
    expect(
      (await getJson(app, `/trips/${t.tripId}/matching`)).body.result.regions
        .passed,
    ).toEqual(["11001"]);
  });
});

describe("표시 이름(사양 03 3장)", () => {
  const all = [
    { code: "11140", name: "중구", sidoCode: "11" },
    { code: "27110", name: "중구", sidoCode: "27" },
    { code: "51820", name: "고성군", sidoCode: "51" },
    { code: "48820", name: "고성군", sidoCode: "48" },
    { code: "51720", name: "홍천군", sidoCode: "51" },
    { code: "41270", name: "안산시", sidoCode: "41" },
    { code: "11110", name: "종로구", sidoCode: "11" },
    { code: "12210", name: "동구", sidoCode: "12" },
  ];
  it("이름이 중복이거나 구로 끝나면 시도 단축명 접두, 유일한 시·군은 그대로", () => {
    const d = (code: string) =>
      regionDisplayName(
        all.find((r) => r.code === code)!,
        all,
      );
    expect(d("11140")).toBe("서울 중구");
    expect(d("27110")).toBe("대구 중구");
    expect(d("51820")).toBe("강원 고성군");
    expect(d("48820")).toBe("경남 고성군");
    expect(d("51720")).toBe("홍천군");
    expect(d("41270")).toBe("안산시");
    expect(d("11110")).toBe("서울 종로구");
    expect(d("12210")).toBe("전남광주 동구");
  });

  it(
    "전국 지역 DB: display_name이 규칙대로이고 summary.lastEvent.name·list.displayName에 쓰인다",
    { skip: !existsSync(NATIONAL) },
    async () => {
      const db = new DatabaseSync(NATIONAL, { readOnly: true });
      const get = (c: string) =>
        (
          db
            .prepare("SELECT display_name FROM regions WHERE code = ?")
            .get(c) as { display_name: string }
        ).display_name;
      expect([get("11140"), get("51820"), get("48820"), get("51720")]).toEqual([
        "서울 중구",
        "강원 고성군",
        "경남 고성군",
        "홍천군",
      ]);
      db.close();
    },
  );
});

describe("S5: 이웃 없는 섬", () => {
  it("neighbors가 0개면 중심점 거리순 가장 가까운 3곳을 nearest: true로 돌려준다", async () => {
    const app = regionsApp() as unknown as TestApp;
    const body = (
      await getJson(app, "/regions/neighbors?code=11113&vehicleId=v")
    ).body;
    expect(body.items.map((i: any) => i.code)).toEqual([
      "11116",
      "11112",
      "11111",
    ]);
    expect(body.items.every((i: any) => i.nearest === true)).toBe(true);
    // 이웃이 있는 곳에는 nearest 표시가 없다
    const a = (await getJson(app, "/regions/neighbors?code=11111")).body;
    expect(a.items.some((i: any) => "nearest" in i)).toBe(false);
  });
});

describe("GET /regions/at, neighbors center (사양 04)", () => {
  it("at: 점이 속한 시군구와 차량 단계·인구감소 여부, 못 찾으면 404, 잘못된 입력은 400", async () => {
    const app = regionsApp() as unknown as TestApp;
    const before = (
      await getJson(app, "/regions/at?lat=37.05&lon=127.05&vehicleId=v")
    ).body;
    expect(before).toMatchObject({
      code: "11111",
      name: "A구",
      displayName: "A구",
      sidoName: "가시",
      level: 0,
      depop92: false,
    });
    expect(before.attribution).toBeTruthy();
    // F구(인구감소 92)
    expect(
      (await getJson(app, "/regions/at?lat=37.05&lon=127.25&vehicleId=v")).body,
    ).toMatchObject({ code: "11116", depop92: true });
    await trip(app, "v", "2026-11-09T01:00:00Z", [IN.A, IN.A]);
    expect(
      (await getJson(app, "/regions/at?lat=37.05&lon=127.05&vehicleId=v")).body
        .level,
    ).toBe(1);
    expect(
      (await getJson(app, "/regions/at?lat=10&lon=100&vehicleId=v")).status,
    ).toBe(404);
    expect((await getJson(app, "/regions/at?lat=x&lon=127")).status).toBe(400);
    expect((await getJson(app, "/regions/at?lat=37")).status).toBe(400);
    (app as unknown as { matching: { stop: () => void } }).matching.stop();
  });

  it("neighbors: 항목마다 bbox 중심 center를 싣는다", async () => {
    const app = regionsApp() as unknown as TestApp;
    const body = (
      await getJson(app, "/regions/neighbors?code=11111&vehicleId=v")
    ).body;
    const e = body.items.find((i: any) => i.code === "11115");
    expect(e.center.lat).toBeCloseTo(37.05, 6);
    expect(e.center.lon).toBeCloseTo(126.95, 6);
    expect(
      body.items.every(
        (i: any) =>
          Number.isFinite(i.center.lat) && Number.isFinite(i.center.lon),
      ),
    ).toBe(true);
    // 이웃 없는 섬(nearest)에도 center가 있다
    const island = (
      await getJson(app, "/regions/neighbors?code=11113&vehicleId=v")
    ).body;
    expect(island.items.every((i: any) => i.nearest && i.center)).toBe(true);
    (app as unknown as { matching: { stop: () => void } }).matching.stop();
  });
});

describe("/regions/geo 캐시", () => {
  it("같은 bbox는 도형을 재사용하되 차량별 단계는 항상 최신이다", async () => {
    const app = regionsApp() as unknown as TestApp;
    const url = "/regions/geo?vehicleId=v&bbox=126.95,37.0,127.15,37.1";
    const levelOfA = async () =>
      (await getJson(app, url)).body.features.find(
        (f: any) => f.properties.code === "11111",
      ).properties.level;
    expect(await levelOfA()).toBe(0);
    await trip(app, "v", "2026-11-09T01:00:00Z", [IN.A, IN.A]);
    expect(await levelOfA()).toBe(1);
    const a = (await getJson(app, url)).body;
    const b = (
      await getJson(
        app,
        `/regions/geo?vehicleId=other&bbox=126.95,37.0,127.15,37.1`,
      )
    ).body;
    expect(b.features.map((f: any) => f.geometry)).toEqual(
      a.features.map((f: any) => f.geometry),
    );
    expect(
      b.features.find((f: any) => f.properties.code === "11111").properties
        .level,
    ).toBe(0);
  });
});

describe("재리뷰 잔여: 잠정 방문 취소·region_jobs·alias 조회·열 검사", () => {
  const A_START = Date.parse("2026-11-09T12:00:00Z");
  const counts = (db: ReturnType<typeof openDb>, v: string, code: string) =>
    db
      .prepare(
        "SELECT level, visits, stays, first_at, last_at FROM visited_regions WHERE vehicle_id = ? AND code = ?",
      )
      .get(v, code) as {
      level: number;
      visits: number;
      stays: number;
      first_at: string;
      last_at: string;
    };

  it("잠정 방문 취소: 다른 방문이 없는 시군구는 level 1·visits 0이고 last_at이 남은 이벤트로 돌아간다", async () => {
    const db = openDb(":memory:");
    const clock = { t: CLOCK0 };
    const app = regionsApp({ db, clock }) as unknown as TestApp & {
      regionsBatch: (n: number) => number;
    };
    const a = await tripAt(app, "v", A_START, [IN.A, IN.A]);
    expect(app.regionsBatch(ms(a.endedAt) + 25 * H)).toBe(1); // 잠정 방문(시각 = 종료 + 24시간)
    expect(counts(db, "v", "11111")).toMatchObject({
      level: 2,
      visits: 1,
      last_at: new Date(ms(a.endedAt) + DAY).toISOString(),
    });
    clock.t = ms(a.endedAt) + 26 * H;
    await tripAt(app, "v", ms(a.endedAt) + 5 * 60_000, [IN.B, IN.B]); // 5분 뒤 시작, 다른 시군구(B)에서 하루 늦게 업로드
    const c = counts(db, "v", "11111");
    expect(c).toMatchObject({ level: 1, visits: 0, stays: 0 });
    // 방문 시각(종료 + 24시간)이 first_at/last_at에 남지 않는다: 남은 이벤트는 통과(트립 시작 시각)뿐
    expect(c.last_at).toBe(new Date(A_START).toISOString());
    expect(c.first_at).toBe(new Date(A_START).toISOString());
  });

  it("잠정 방문 취소: 남은 다른 방문이 있으면 그 시각으로 돌아가고 단계는 방문(2)", async () => {
    const db = openDb(":memory:");
    const clock = { t: CLOCK0 };
    const app = regionsApp({ db, clock }) as unknown as TestApp & {
      regionsBatch: (n: number) => number;
    };
    const first = await tripAt(app, "v", Date.parse("2026-11-09T01:00:00Z"), [
      IN.A,
      IN.A,
    ]);
    await tripAt(app, "v", ms(first.endedAt) + 30 * 60_000, [IN.A, IN.A]); // 30분 뒤: 첫 트립의 방문(2)이 확정됨
    const a = await tripAt(app, "v", A_START, [IN.A, IN.A]);
    expect(app.regionsBatch(ms(a.endedAt) + 25 * H)).toBeGreaterThan(0);
    const before = counts(db, "v", "11111");
    expect(before.last_at).toBe(new Date(ms(a.endedAt) + DAY).toISOString());
    clock.t = ms(a.endedAt) + 26 * H;
    await tripAt(app, "v", ms(a.endedAt) + 5 * 60_000, [IN.B, IN.B]);
    const after = counts(db, "v", "11111");
    expect(after.level).toBe(2);
    expect(after.visits).toBe(before.visits - 1);
    expect(after.last_at < before.last_at).toBe(true);
  });

  it("region_jobs는 7일을 넘기면 failed로 포기하고 result.regions를 failed로 남긴다(7일 직전까지는 재시도 대기)", async () => {
    const db = openDb(":memory:");
    const clock = { t: CLOCK0 };
    const app = createApp(db, {
      vehicleHmacKey: "k",
      roadsPath: ROADS_TEST_DB,
      regionsPath: null,
      retryDelayMs: 60_000,
      now: () => clock.t,
    });
    const t = await trip(
      app as unknown as TestApp,
      "v",
      "2026-11-09T01:00:00Z",
      [IN.A, IN.A],
    );
    const status = () =>
      db
        .prepare("SELECT status, error FROM region_jobs WHERE trip_id = ?")
        .get(t.tripId);
    const regionsOf = async () =>
      (await getJson(app as unknown as TestApp, `/trips/${t.tripId}/matching`))
        .body.result.regions;
    expect(await regionsOf()).toBe("pending");
    clock.t = CLOCK0 + 7 * DAY - 1;
    app.matching.runRegionJob(t.tripId);
    expect(status()).toMatchObject({ status: "queued" });
    clock.t = CLOCK0 + 7 * DAY;
    app.matching.runRegionJob(t.tripId);
    expect(status()).toEqual({ status: "failed", error: "retry_exhausted" });
    expect(await regionsOf()).toBe("failed");
    app.matching.stop();
  });

  it("재기동 복구는 region_jobs를 트립 시작 순으로 처리한다(업로드 순서와 무관)", async () => {
    const file = join(tmp(), "order.sqlite");
    const clock = { t: CLOCK0 };
    const app1 = createApp(openDb(file), {
      vehicleHmacKey: "k",
      roadsPath: ROADS_TEST_DB,
      regionsPath: null,
      retryDelayMs: 60_000,
      now: () => clock.t,
    });
    // 나중에 시작한 트립(A)이 먼저 올라오고(queued_at 빠름), 일찍 시작한 트립(B)이 나중에 올라온다
    await trip(app1 as unknown as TestApp, "v", "2026-11-09T03:00:00Z", [
      IN.A,
      IN.A,
    ]);
    clock.t += 1000;
    await trip(app1 as unknown as TestApp, "v", "2026-11-09T01:00:00Z", [
      IN.B,
      IN.B,
    ]);
    app1.matching.stop();
    const db2 = openDb(file);
    const app2 = regionsApp({ db: db2, clock }) as unknown as TestApp & {
      matching: { start: () => void };
    };
    app2.matching.start();
    const order = db2
      .prepare("SELECT code FROM region_events WHERE kind = 'pass' ORDER BY id")
      .all();
    expect(order).toEqual([{ code: "11112" }, { code: "11111" }]); // B(01:00 시작) → A(03:00 시작)
    app2.matching.stop();
  });

  it("alias(UUID)로 조회해도 정본 기록을 합산한다(summary·list·geo·neighbors)", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO vehicle_alias VALUES (?, ?)").run(
      "a-uuid",
      "m-srv",
    );
    const app = regionsApp({ db }) as unknown as TestApp;
    await trip(app, "m-srv", "2026-11-09T01:00:00Z", [IN.A, IN.A]); // 정본으로 A
    await trip(app, "a-uuid", "2026-11-09T01:05:00Z", [IN.B, IN.B]); // alias로 B(간격 5분: 방문 없음)
    for (const v of ["m-srv", "a-uuid"]) {
      expect(
        (await getJson(app, `/regions/summary?vehicleId=${v}`)).body.colored,
      ).toBe(2);
      expect(await level(app, v, "11111")).toBe(1);
      expect(await level(app, v, "11112")).toBe(1);
      const geo = (
        await getJson(
          app,
          `/regions/geo?vehicleId=${v}&bbox=126.95,37.0,127.15,37.1`,
        )
      ).body.features;
      expect(
        geo.find((f: any) => f.properties.code === "11111").properties.level,
      ).toBe(1);
      const nb = (
        await getJson(app, `/regions/neighbors?code=11111&vehicleId=${v}`)
      ).body.items;
      expect(nb.find((i: any) => i.code === "11112").level).toBe(1);
    }
  });

  it("display_name 열이 없는 옛 지역 DB는 열지 않고(DETACH) 지역 API는 503", async () => {
    const path = join(tmp(), "old.sqlite");
    makeRegionsDb(path, LAYOUT);
    const old = new DatabaseSync(path);
    old.exec("ALTER TABLE regions DROP COLUMN display_name");
    old.close();
    const db = openDb(":memory:");
    const app = createApp(db, {
      vehicleHmacKey: "k",
      roadsPath: ROADS_TEST_DB,
      regionsPath: path,
      retryDelayMs: 60_000,
    });
    const r = await getJson(
      app as unknown as TestApp,
      "/regions/summary?vehicleId=v",
    );
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: "regions_db_unavailable" });
    expect(
      (db.prepare("PRAGMA database_list").all() as { name: string }[]).map(
        (d) => d.name,
      ),
    ).not.toContain("rg");
    app.matching.stop();
  });
});
