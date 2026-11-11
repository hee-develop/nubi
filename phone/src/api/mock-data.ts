import type { RegionItem, RoadItem, TripSummary } from './types';

/** 시도별 시군구 수(합 229). 목 데이터용이며 이름은 서울·강원·제주만 실제 이름이고 나머지는 '<시도> n'이다. */
const SIDO: [code: string, name: string, n: number][] = [
  ['11', '서울', 25], ['26', '부산', 16], ['27', '대구', 8], ['28', '인천', 10], ['29', '광주', 5], ['30', '대전', 5],
  ['31', '울산', 5], ['36', '세종', 1], ['41', '경기', 31], ['51', '강원', 18], ['43', '충북', 11], ['44', '충남', 15],
  ['52', '전북', 14], ['46', '전남', 22], ['47', '경북', 23], ['48', '경남', 18], ['50', '제주', 2],
];
const SEOUL = ['종로구', '중구', '용산구', '성동구', '광진구', '동대문구', '중랑구', '성북구', '강북구', '도봉구', '노원구', '은평구', '서대문구', '마포구', '양천구', '강서구', '구로구', '금천구', '영등포구', '동작구', '관악구', '서초구', '강남구', '송파구', '강동구'];
const GANGWON = ['춘천시', '원주시', '강릉시', '동해시', '태백시', '속초시', '삼척시', '홍천군', '횡성군', '영월군', '평창군', '정선군', '철원군', '화천군', '양구군', '인제군', '고성군', '양양군'];
const JEJU = ['제주시', '서귀포시'];

const NOW = Date.parse('2026-11-11T09:00:00+09:00');
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86400000).toISOString();

/** 단계·바램 예시(코드 접미: 시도코드+순번). */
const LEVELS: Record<string, { level: number; faded?: boolean; daysAgo: number }> = {
  '11110': { level: 1, daysAgo: 3 },
  '11140': { level: 3, daysAgo: 1 },
  '51720': { level: 2, daysAgo: 12 },
  '51800': { level: 3, daysAgo: 400, faded: true },
  '51790': { level: 1, daysAgo: 30 },
};

export const buildRegions = (): RegionItem[] => {
  const out: RegionItem[] = [];
  let i = 0;
  for (const [sido, sidoName, n] of SIDO) {
    for (let k = 0; k < n; k++) {
      const name = sido === '11' ? SEOUL[k]! : sido === '51' ? GANGWON[k]! : sido === '50' ? JEJU[k]! : `${sidoName} ${k + 1}`;
      // 시연 코드: 서울 종로 11110·중 11140, 강원 홍천 51720·양구 51800·인제 51790
      const code =
        sido === '11' && name === '종로구' ? '11110' :
        sido === '11' && name === '중구' ? '11140' :
        sido === '51' && name === '홍천군' ? '51720' :
        sido === '51' && name === '양구군' ? '51800' :
        sido === '51' && name === '인제군' ? '51790' :
        `${sido}${String(100 + k * 10 + 1).padStart(3, '0')}`;
      const l = LEVELS[code];
      // 정확히 92곳을 고르게 인구감소지역으로 표시(Bresenham)
      const depop = Math.floor(((i + 1) * 92) / 229) - Math.floor((i * 92) / 229) === 1;
      out.push({
        code,
        name,
        displayName: sidoName === name ? name : `${sidoName} ${name}`,
        sidoName,
        level: l?.level ?? 0,
        depop89: depop,
        depop92: depop,
        firstAt: l ? iso(l.daysAgo + 5) : null,
        lastAt: l ? iso(l.daysAgo) : null,
        passes: l ? 2 : 0,
        visits: l && l.level >= 2 ? 1 : 0,
        stays: l && l.level >= 3 ? 1 : 0,
        faded: l?.faded ?? false,
      });
      i++;
    }
  }
  return out;
};

export const buildRoads = (): RoadItem[] => {
  const spec: [string, string, number, number][] = [
    ['국도 31호선', 'primary', 142000, 91.2], ['서울 외곽순환', 'motorway', 128000, 88.4], ['경부고속도로', 'motorway', 416000, 83.1],
    ['세종대로', 'secondary', 3200, 96.5], ['중부내륙고속도로', 'motorway', 301000, 42.0], ['44번 국도', 'primary', 210000, 12.5],
    ['올림픽대로', 'motorway', 39000, 100], ['북악산로', 'secondary', 5600, 82.0], ['영동고속도로', 'motorway', 234000, 9.3],
    ['강변북로', 'motorway', 31000, 100], ['남산순환로', 'secondary', 7400, 51.0], ['서해안고속도로', 'motorway', 336000, 1.2],
  ];
  return spec.map(([displayName, highway, totalM, percent], i) => ({
    roadKey: `mock-road-${i + 1}`,
    displayName,
    highway,
    names: [displayName],
    namesTotal: 1,
    drivenM: Math.round((totalM * percent) / 100),
    totalM,
    percent,
    completed: percent >= 95,
    lastDrivenAt: iso(i * 3 + 1),
  }));
};

export const buildTrips = (vehicleId: string): TripSummary[] =>
  [0, 1, 2, 3, 4].map((i) => ({
    tripId: `mock-trip-${i + 1}`,
    localId: `l${i + 1}`,
    vehicleId,
    driverId: 'mock-driver',
    startedAt: iso(i + 0.4),
    endedAt: iso(i + 0.3),
    odometerStartKm: 12000 + i * 40,
    odometerEndKm: 12000 + i * 40 + 22 + i,
    pointCount: 400 + i * 30,
    distanceM: 22000 + i * 1500,
    durationS: 3000 + i * 240,
  }));
