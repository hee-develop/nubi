export function pointInRing(x: number, y: number, r: number[][]): boolean;
export function pointInMulti(x: number, y: number, polys: number[][][][]): boolean;
export function distanceToMultiM(x: number, y: number, polys: number[][][][]): number;
export const GAP_FIX_M: number;
export type LocatedRegion = { code: string; name: string; display_name: string; sido_code: string; sido_name: string };
export function makeLocator(
  db: { prepare(sql: string): { all(...a: unknown[]): any[]; get(...a: unknown[]): any } },
  opts?: { schema?: string; maxGapM?: number },
): { locate: (lon: number, lat: number) => LocatedRegion | null; polygons: (code: string) => number[][][][] | null };
export const SIDO_SHORT: Record<string, string>;
export function regionDisplayName(region: { name: string; sidoCode: string }, all: { name: string }[]): string;
