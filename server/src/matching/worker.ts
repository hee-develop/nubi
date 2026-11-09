/** 맵매칭 워커: 프로세스 내 단일 소비자. 실패(네트워크·5xx)는 5분 간격으로 최대 24시간 재시도하고 4xx는 영구 실패로 둔다(사양 02 4장). */
import type { Db } from '../db/index.js';
import type { Roads } from '../roads/index.js';
import { runMatching } from './pipeline.js';
import { ValhallaError, type TraceDeps } from './valhalla.js';

export type MatchingStatus = 'queued' | 'running' | 'done' | 'failed';

export const RETRY_DELAY_MS = 5 * 60 * 1000;
export const RETRY_LIMIT_MS = 24 * 60 * 60 * 1000;

export type WorkerDeps = {
  db: Db;
  roads: () => Roads | null;
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

  const fail = (tripId: string, error: string, queuedAt: string, retryable: boolean) => {
    const exhausted = retryable && now() - Date.parse(queuedAt) >= retryLimitMs;
    const permanent = !retryable || exhausted;
    db.prepare("UPDATE trip_matching SET status = 'failed', error = ?, finished_at = ? WHERE trip_id = ?").run(
      `${permanent ? 'permanent' : 'retryable'}: ${exhausted ? 'retry_exhausted ' : ''}${error}`,
      iso(),
      tripId,
    );
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
    if (!roads) return fail(tripId, 'roads_db_unavailable', row.queued_at, true);
    try {
      const result = await runMatching(db, roads, tripId, deps.trace ?? {});
      db.prepare("UPDATE trip_matching SET status = 'done', error = NULL, finished_at = ?, result_json = ? WHERE trip_id = ?").run(
        iso(),
        JSON.stringify(result),
        tripId,
      );
    } catch (e) {
      if (e instanceof ValhallaError) fail(tripId, e.message, row.queued_at, e.retryable);
      else fail(tripId, e instanceof Error ? e.message : String(e), row.queued_at, true);
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

  const enqueue = (tripId: string) => {
    if (stopped || queue.includes(tripId)) return;
    queue.push(tripId);
    running ??= pump().finally(() => {
      running = null;
      if (queue.length > 0) running = pump().finally(() => (running = null));
    });
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
    },
    /** 큐가 빌 때까지(재시도 타이머는 기다리지 않는다). 테스트용. */
    async idle() {
      while (running || queue.length > 0) await running;
    },
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
};
