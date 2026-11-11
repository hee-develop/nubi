/**
 * 공유 카드·내 지도 이미지 렌더러(plan 10-1). 도형은 도로 DB·지역 DB에서 읽되 **화면 픽셀 좌표로만** SVG에 싣는다.
 * 경도·위도 원본, way id, 차량 ID는 SVG에 들어가지 않는다. PNG는 SVG를 `@resvg/resvg-js`로 변환한다(없으면 SVG만).
 * 바탕 타일은 쓰지 않는다(사양 05): 서버가 가진 도로·시군구 도형만 그린다.
 */
export type LonLat = [number, number];
export type Seg = { pts: LonLat[]; style: 'driven' | 'faded' | 'dim' | 'trip' };
export type Poly = { rings: LonLat[][]; level: 0 | 1 | 2 | 3; faded: boolean; depop: boolean };

export const COLORS = {
  bg: '#0f141b',
  panel: '#151d28',
  line: '#243041',
  mapBg: '#111821',
  grid: '#1c2633',
  road: '#2a3544',
  driven: '#f59e0b',
  faded: '#c79a4c',
  fresh: '#fbbf24',
  depop: '#1c323a',
  text: '#e8eef6',
  muted: '#8b9bb0',
} as const;

export const FONT = "'Apple SD Gothic Neo','Noto Sans CJK KR','Noto Sans KR','Malgun Gothic','NanumGothic',sans-serif";

/** 전국 고정 축척 범위(울릉·독도·마라도 포함). */
export const KOREA_BBOX: [number, number, number, number] = [124.5, 33.0, 131.95, 38.7];

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** bbox를 [w]x[h] 안에 비율을 지켜 맞추는 투영(경도는 중간 위도의 cos로 보정). 좌표는 소수 1자리 픽셀. */
export const fit = (bbox: [number, number, number, number], w: number, h: number, pad = 0.04) => {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = Math.max(1e-6, (maxLon - minLon) * k);
  const spanY = Math.max(1e-6, maxLat - minLat);
  const scale = Math.min((w * (1 - 2 * pad)) / spanX, (h * (1 - 2 * pad)) / spanY);
  const ox = (w - spanX * scale) / 2;
  const oy = (h - spanY * scale) / 2;
  return (p: LonLat): [number, number] => [Math.round((ox + (p[0] - minLon) * k * scale) * 10) / 10, Math.round((oy + (maxLat - p[1]) * scale) * 10) / 10];
};

/** 픽셀 간격 [minPx] 미만의 점을 솎는다(처음·끝은 남긴다). 점 하나로 줄면 짧은 점 선으로 그린다. */
const pathOf = (pts: [number, number][], minPx: number, seen: Set<string>): string => {
  if (pts.length === 0) return '';
  const kept: [number, number][] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = kept.at(-1)!;
    if (Math.hypot(pts[i]![0] - a[0], pts[i]![1] - a[1]) >= minPx) kept.push(pts[i]!);
  }
  if (pts.length > 1) kept.push(pts.at(-1)!);
  const last = kept.at(-1)!;
  if (kept.length === 2 && Math.hypot(last[0] - kept[0]![0], last[1] - kept[0]![1]) < 0.4) {
    const key = `${kept[0]![0]},${kept[0]![1]}`;
    if (seen.has(key)) return '';
    seen.add(key);
    return `M${kept[0]![0]} ${kept[0]![1]}h0.1`;
  }
  return 'M' + kept.map((p) => `${p[0]} ${p[1]}`).join('L');
};

const POINT_BUDGET = 60_000;

/** 지도 영역 안(0,0)-(w,h)에 그릴 SVG 조각: 시군구 면 → 도로 선. */
export const mapContent = (opts: { project: (p: LonLat) => [number, number]; polys?: Poly[]; segs?: Seg[]; w: number; h: number; lineWidth?: number; thin?: number }): string => {
  const { project, w, h } = opts;
  const lw = opts.lineWidth ?? 1.6;
  const thin = opts.thin ?? 0.8;
  let out = '';
  let budget = POINT_BUDGET;
  const inView = (pts: [number, number][]) => pts.some((p) => p[0] >= -20 && p[0] <= w + 20 && p[1] >= -20 && p[1] <= h + 20);
  // 시군구: 단계별 면 색(앰버 농도 3단계, 바랜 곳은 채도 50%), 안 간 인구감소지역은 바탕색만
  const fills = new Map<string, string[]>();
  let outline = '';
  for (const poly of opts.polys ?? []) {
    const base = poly.faded ? COLORS.faded : COLORS.driven;
    const key = poly.level > 0 ? `${base}|${[0, 0.38, 0.6, 0.85][poly.level]}` : poly.depop ? `${COLORS.depop}|1` : '';
    let d = '';
    for (const ring of poly.rings) {
      const px = ring.map(project);
      if (!inView(px) || budget <= 0) continue;
      const s = pathOf(px, thin * 1.5, new Set());
      budget -= px.length;
      if (s) d += s + 'Z';
    }
    if (!d) continue;
    outline += d;
    if (key) fills.set(key, [...(fills.get(key) ?? []), d]);
  }
  if (outline) out += `<path d="${outline}" fill="none" stroke="${COLORS.line}" stroke-width="0.6" stroke-linejoin="round"/>`;
  // 칠한 시군구는 면 + 앰버 윤곽(전국 축척에서도 보이게). 안 간 인구감소지역(#1c323a)은 면만.
  for (const [key, ds] of fills) {
    const [color, opacity] = key.split('|');
    out += color === COLORS.depop ? `<path d="${ds.join('')}" fill="${color}" fill-opacity="${opacity}" stroke="none"/>` : `<path d="${ds.join('')}" fill="${color}" fill-opacity="${opacity}" stroke="${color}" stroke-width="1" stroke-linejoin="round"/>`;
  }
  // 도로: 안 달린(dim) → 바랜(faded) → 달린(driven) → 이번 여행(trip) 순으로 위에 쌓는다.
  for (const style of ['dim', 'faded', 'driven', 'trip'] as const) {
    const seen = new Set<string>();
    let d = '';
    for (const seg of opts.segs ?? []) {
      if (seg.style !== style || budget <= 0) continue;
      const px = seg.pts.map(project);
      if (!inView(px)) continue;
      budget -= px.length;
      d += pathOf(px, thin, seen);
    }
    if (!d) continue;
    const color = { dim: COLORS.road, faded: COLORS.faded, driven: COLORS.driven, trip: COLORS.driven }[style];
    const width = style === 'trip' ? Math.max(lw, 6) : style === 'dim' ? Math.max(1, lw * 0.8) : lw;
    out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return out;
};

/** 글자 폭을 어림해(한글 1em, 그 밖 0.55em) 한 줄이 [width]px 안에 들어가는 글자 크기. */
export const fitSize = (text: string, max: number, width: number, min = 22): number => {
  let em = 0;
  for (const ch of text) em += /[ᄀ-ᇿ㄰-㆏가-힯一-鿿]/.test(ch) ? 1 : 0.58;
  return Math.max(min, Math.min(max, Math.floor(width / Math.max(em, 1))));
};

export type CardText = { label: string; lines: [string, string?, string?, string?]; aria: string };

/** 800x960 카드 한 장. [mapInner]는 720x540 지도 영역 안의 SVG 조각(좌표는 0..720 x 0..540). */
export const cardSvg = (mapInner: string, text: CardText, opts: { fade?: boolean } = {}): string => {
  const colors = [COLORS.text, COLORS.driven, COLORS.fresh, COLORS.muted];
  const lines = text.lines
    .map((l, i) => {
      if (!l) return '';
      const size = i === 3 ? 30 : fitSize(l, 46, 720);
      return `<text x="40" y="${715 + i * 62}" font-size="${size}" font-weight="${i === 3 ? 500 : 800}" fill="${colors[i]}">${esc(l)}</text>`;
    })
    .join('');
  const fade = opts.fade
    ? `<rect width="720" height="540" fill="url(#fadeL)"/><rect width="720" height="540" fill="url(#fadeR)"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="960" viewBox="0 0 800 960" role="img" aria-label="${esc(text.aria)}" font-family="${FONT}">
<defs>
<pattern id="g" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="${COLORS.grid}" stroke-width="2"/></pattern>
<linearGradient id="fadeL" x1="0" x2="1"><stop offset="0" stop-color="${COLORS.mapBg}" stop-opacity="1"/><stop offset=".22" stop-color="${COLORS.mapBg}" stop-opacity="0"/></linearGradient>
<linearGradient id="fadeR" x1="0" x2="1"><stop offset=".78" stop-color="${COLORS.mapBg}" stop-opacity="0"/><stop offset="1" stop-color="${COLORS.mapBg}" stop-opacity="1"/></linearGradient>
<clipPath id="mapclip"><rect x="40" y="110" width="720" height="540" rx="26"/></clipPath>
</defs>
<rect width="800" height="960" rx="40" fill="${COLORS.panel}" stroke="${COLORS.line}" stroke-width="2"/>
<text x="40" y="82" font-size="48" font-weight="800" fill="${COLORS.driven}">누비</text>
<text x="760" y="80" font-size="28" fill="${COLORS.muted}" text-anchor="end">${esc(text.label)}</text>
<rect x="40" y="110" width="720" height="540" rx="26" fill="${COLORS.mapBg}" stroke="${COLORS.line}" stroke-width="2"/>
<g clip-path="url(#mapclip)"><g transform="translate(40 110)"><rect width="720" height="540" fill="url(#g)"/>${mapInner}${fade}</g></g>
${lines}
<text x="40" y="928" font-size="22" fill="${COLORS.muted}">© OpenStreetMap contributors</text>
<text x="760" y="928" font-size="24" font-weight="700" fill="${COLORS.driven}" text-anchor="end">누비</text>
</svg>`;
};

/** 내 지도 요약용 작은 지도(웹 페이지 인라인). 카드와 같은 그리기 함수를 쓴다. */
export const miniMapSvg = (mapInner: string, aria: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 540" role="img" aria-label="${esc(aria)}" style="width:100%;height:auto;display:block;border-radius:16px;background:${COLORS.mapBg}"><rect width="720" height="540" fill="${COLORS.mapBg}"/>${mapInner}</svg>`;

type ResvgModule = typeof import('@resvg/resvg-js');
let resvg: Promise<ResvgModule | null> | null = null;
const loadResvg = () => (resvg ??= import('@resvg/resvg-js').then((m) => m, () => null));

/** PNG 변환이 가능한가(`@resvg/resvg-js`가 올라오는가). */
export const pngAvailable = async (): Promise<boolean> => (await loadResvg()) !== null;

/** SVG → PNG(가로 800). 변환기가 없으면 null. */
export const svgToPng = async (svg: string, fontFile?: string): Promise<Buffer | null> => {
  const mod = await loadResvg();
  if (!mod) return null;
  const font = fontFile ?? process.env.NUBI_CARD_FONT;
  const r = new mod.Resvg(svg, { fitTo: { mode: 'width', value: 800 }, font: { loadSystemFonts: true, ...(font ? { fontFiles: [font] } : {}) } });
  return Buffer.from(r.render().asPng());
};
