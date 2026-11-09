/**
 * 맵매칭 워커: 프로세스 내 단일 소비자. 실패(네트워크·5xx)는 5분 간격으로 최대 24시간 재시도하고 4xx는 영구 실패로 둔다(사양 02 4장).
 * `trip_matching.error`에는 `retryable:<코드>`·`permanent:<코드>`만 남기고(API가 그대로 내려 준다) 메시지는 서버 로그로만 보낸다.
 */
import type { Db } from '../db/index.js';
import type { Regions } from '../regions/index.js';
import { inTx, judgeTrip, resolvePending } from '../regions/judge.js';
import type { Roads } from '../roads/index.js';
import { runMatching } from './pipeline.js';
import { ValhallaError, type TraceDeps } from './valhalla.js';

export type MatchingStatus = 'queued' | 'running' | 'done' | 'failed';

export const RETRY_DELAY_MS = 5 * 60 * 1000;
export const RETRY_LIMIT_MS = 24 * 60 * 60 * 1000;
/** 지역 판정 재시도 상한(사양 03 4장). 간격은 매칭과 같은 [RETRY_DELAY_MS]. */
export const REGION_RETRY_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

export type WorkerDeps = {
  db: Db;
  roads: () => Roads | null;
  /** 지역 DB. 생략하면 시군구 판정을 하지 않는다. 판정은 매칭과 분리된 작업(region_jobs)이라 null을 돌려줘도(DB 없음) 매칭은 끝나고 판정만 재시도 대기한다. */
  regions?: () => Regions | null;
  trace?: TraceDeps;
  retryDelayMs?: number;
  retryLimitMs?: number;
  now?: () => number;
};

export type MatchingWorker = ReturnType<typeof createMatchingWorker>;

/** 트립이 끝났을 때 큐에 넣는다. 이미 있으면 그대로 두고 현재 상태를 돌려준다(멱등). */
export const queueMatching = (db: Db, tripId: string): { status: string; created: boolean } => {
  const r = db
    .prepare("INSERT OR IGNORE INTO trip_matching (trip_id, status, attempts, queued_at) VALUES (?, 'queued', 0, ?)")
    .run(tripId, new Date().toISOString());
  const row = db.prepare('SELECT status FROM trip_matching WHERE trip_id = ?').get(tripId) as { status: string };
  return { status: row.status, created: Number(r.changes) > 0 };
};

export const createMatchingWorker = (deps: WorkerDeps) => {
  const { db } = deps;
  const retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
  const retryLimitMs = deps.retryLimitMs ?? RETRY_LIMIT_MS;
  const now = deps.now ?? Date.now;
  const queue: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let running: Promise<void> | null = null;
  let stopped = false;

  const iso = () => new Date(now()).toISOString();

  const fail = (tripId: string, code: string, detail: string, queuedAt: string, retryable: boolean) => {
    const exhausted = retryable && now() - Date.parse(queuedAt) >= retryLimitMs;
    const permanent = !retryable || exhausted;
    const stored = `${permanent ? 'permanent' : 'retryable'}:${exhausted ? 'retry_exhausted' : code}`;
    console.warn(`맵매칭 실패 trip=${tripId} ${stored} (${detail})`);
    db.prepare("UPDATE trip_matching SET status = 'failed', error = ?, finished_at = ? WHERE trip_id = ?").run(stored, iso(), tripId);
    if (!permanent && !stopped) {
      const t = setTimeout(() => {
        timers.delete(t);
        enqueue(tripId);
      }, retryDelayMs);
      t.unref?.();
      timers.add(t);
    }
  };

  const processOne = async (tripId: string) => {
    const row = db.prepare('SELECT status, error, queued_at FROM trip_matching WHERE trip_id = ?').get(tripId) as
      { status: string; error: string | null; queued_at: string } | undefined;
    if (!row || row.status === 'done' || (row.status === 'failed' && row.error?.startsWith('permanent'))) return;
    db.prepare("UPDATE trip_matching SET status = 'running', attempts = attempts + 1, started_at = ?, error = NULL WHERE trip_id = ?").run(
      iso(),
      tripId,
    );
    const roads = deps.roads();
    if (!roads) return fail(tripId, 'roads_db_unavailable', '도로 DB 없음', row.queued_at, true);
    try {
      // done 표시는 driven_ways 갱신과 같은 트랜잭션 안에서 한다(runMatching이 finish를 거기서 부른다).
      const result = await runMatching(db, roads, tripId, deps.trace ?? {}, (r) => {
        // 지역 판정 작업 등록은 done 표시와 같은 트랜잭션. 의심(suspect) 트립은 판정하지 않는다.
        const judged = deps.regions !== undefined && r.outcome !== 'suspect';
        if (judged) {
          r.regions = 'pending';
          db.prepare("INSERT OR IGNORE INTO region_jobs (trip_id, status, attempts, queued_at) VALUES (?, 'queued', 0, ?)").run(
            tripId,
            iso(),
          );
        }
        db.prepare("UPDATE trip_matching SET status = 'done', error = NULL, finished_at = ?, result_json = ? WHERE trip_id = ?").run(
          iso(),
          JSON.stringify(r),
          tripId,
        );
      });
      if (result.regions === 'pending') processRegionJob(tripId);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      if (e instanceof ValhallaError) fail(tripId, e.code, detail, row.queued_at, e.retryable);
      else fail(tripId, 'internal', detail, row.queued_at, true);
    }
  };

  /** 지역 판정 작업 한 건: 통과 반영·pending 기록·지난 pending 판정·result_json.regions 갱신을 한 트랜잭션으로. 실패(지역 DB 없음 등)는 매칭 결과와 무관하게 재시도한다. */
  const processRegionJob = (tripId: string) => {
    const job = db.prepare('SELECT status, queued_at FROM region_jobs WHERE trip_id = ?').get(tripId) as
      { status: string; queued_at: string } | undefined;
    if (!job || job.status !== 'queued') return;
    db.prepare('UPDATE region_jobs SET attempts = attempts + 1 WHERE trip_id = ?').run(tripId);
    const failRegion = (code: string, detail: string) => {
      const exhausted = now() - Date.parse(job.queued_at) >= REGION_RETRY_LIMIT_MS;
      console.warn(`지역 판정 실패 trip=${tripId} ${code} (${detail})`);
      db.prepare('UPDATE region_jobs SET status = ?, error = ?, finished_at = ? WHERE trip_id = ?').run(
        exhausted ? 'failed' : 'queued',
        exhausted ? 'retry_exhausted' : code,
        exhausted ? iso() : null,
        tripId,
      );
      if (!exhausted && !stopped) {
        const t = setTimeout(() => {
          timers.delete(t);
          processRegionJob(tripId);
        }, retryDelayMs);
        t.unref?.();
        timers.add(t);
      }
    };
    const regions = deps.regions?.() ?? null;
    if (!regions) return failRegion('regions_db_unavailable', '지역 DB 없음');
    try {
      inTx(db, () => {
        const trip = db.prepare('SELECT vehicle_id, ended_at FROM trips WHERE id = ?').get(tripId) as {
          vehicle_id: string;
          ended_at: string | null;
        };
        const points = db.prepare('SELECT lat, lon, ts FROM trip_points WHERE trip_id = ? ORDER BY seq').all(tripId) as {
          lat: number;
          lon: number;
          ts: string;
        }[];
        const rg = judgeTrip(db, regions, { id: tripId, vehicleId: trip.vehicle_id, endedAt: trip.ended_at }, points);
        resolvePending(db, regions, trip.vehicle_id, now());
        const m = db.prepare('SELECT result_json FROM trip_matching WHERE trip_id = ?').get(tripId) as { result_json: string };
        db.prepare('UPDATE trip_matching SET result_json = ? WHERE trip_id = ?').run(
          JSON.stringify({ ...JSON.parse(m.result_json), regions: rg }),
          tripId,
        );
        db.prepare("UPDATE region_jobs SET status = 'done', error = NULL, finished_at = ? WHERE trip_id = ?").run(iso(), tripId);
      });
    } catch (e) {
      failRegion('internal', e instanceof Error ? e.message : String(e));
    }
  };

  const pump = async () => {
    while (queue.length > 0 && !stopped) {
      const id = queue.shift()!;
      try {
        await processOne(id);
      } catch (e) {
        console.warn(`맵매칭 작업 오류: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  const kick = () => {
    if (running || stopped || queue.length === 0) return;
    running = pump().finally(() => {
      running = null;
      kick(); // 처리 중에 들어온 작업이 있으면 이어서 돈다
    });
  };

  const enqueue = (tripId: string) => {
    if (stopped || queue.includes(tripId)) return;
    queue.push(tripId);
    kick();
  };

  return {
    enqueue,
    /** 프로세스가 다시 뜰 때 끝나지 않은 작업(queued·running·재시도 대기 failed)을 큐에 올린다. */
    start() {
      const rows = db
        .prepare(
          "SELECT trip_id FROM trip_matching WHERE status IN ('queued', 'running') OR (status = 'failed' AND error LIKE 'retryable:%')",
        )
        .all() as { trip_id: string }[];
      for (const r of rows) enqueue(r.trip_id);
      const jobs = db.prepare("SELECT trip_id FROM region_jobs WHERE status = 'queued'").all() as { trip_id: string }[];
      for (const j of jobs) processRegionJob(j.trip_id);
    },
    /** 지금 돌고 있는 작업이 끝날 때까지(재시도 타이머는 기다리지 않는다). `stop()` 뒤에는 남은 큐를 비우므로 곧 돌아온다. 테스트용. */
    async idle() {
      while (running) await running;
    },
    /** 테스트·수동 재시도용: 대기 중인 지역 판정 작업 한 건을 지금 돌린다. */
    runRegionJob: processRegionJob,
    stop() {
      stopped = true;
      queue.length = 0;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
};
