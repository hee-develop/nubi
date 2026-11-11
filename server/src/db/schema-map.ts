/** 차량 지도 트랙(T1) 테이블. 주행 중 잠정 매칭 결과만 담고, 완료율·도감(driven_ways·visited_regions)에는 절대 쓰지 않는다. */
export const MAP_SCHEMA = `
-- 트립별 잠정 매칭 진행 상태. up_to_seq: 잠정 매칭에 쓴 마지막 점의 seq.
CREATE TABLE IF NOT EXISTS trip_live (
  trip_id TEXT PRIMARY KEY REFERENCES trips (id),
  up_to_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- 잠정으로 인정한 way. is_new: 매칭 시점에 그 차량이 한 번도 인정받지 못한 way였다(첫 인정 순간의 스냅샷이라 트립 종료 뒤에도 바뀌지 않는다).
CREATE TABLE IF NOT EXISTS trip_live_ways (
  trip_id TEXT NOT NULL REFERENCES trips (id),
  way_id INTEGER NOT NULL,
  is_new INTEGER NOT NULL,
  PRIMARY KEY (trip_id, way_id)
);
`;
