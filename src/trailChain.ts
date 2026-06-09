import type { TrailSelection } from "./ElevationProfile";

// Endpoint match tolerances for chaining segments (xyz at the ends).
const EPS_DEG = 1e-5; // ~1 m in lon/lat
const EPS_ELEV = 2; // meters

export function haversineMeters(a: number[], b: number[]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function samePoint(a: number[], b: number[]): boolean {
  return (
    Math.abs(a[0] - b[0]) < EPS_DEG &&
    Math.abs(a[1] - b[1]) < EPS_DEG &&
    Math.abs((a[2] ?? 0) - (b[2] ?? 0)) < EPS_ELEV
  );
}

export type Oriented = { sel: TrailSelection; coords: number[][] };

// Greedily chain segments so consecutive ones share an endpoint (xyz),
// reversing where needed; unmatched segments are appended in place.
export function chainSegments(selections: TrailSelection[]): Oriented[] {
  const pool: Oriented[] = selections.map((sel) => ({
    sel,
    coords: sel.coords,
  }));
  if (pool.length <= 1) return pool;

  const chain: Oriented[] = [pool.shift()!];
  let extended = true;
  while (extended && pool.length) {
    extended = false;
    const headCoords = chain[0].coords;
    const tailCoords = chain[chain.length - 1].coords;
    const front = headCoords[0];
    const back = tailCoords[tailCoords.length - 1];

    for (let i = 0; i < pool.length; i++) {
      const c = pool[i].coords;
      const s = c[0];
      const e = c[c.length - 1];
      if (samePoint(back, s)) {
        chain.push(pool.splice(i, 1)[0]);
      } else if (samePoint(back, e)) {
        const seg = pool.splice(i, 1)[0];
        chain.push({ sel: seg.sel, coords: [...seg.coords].reverse() });
      } else if (samePoint(front, e)) {
        chain.unshift(pool.splice(i, 1)[0]);
      } else if (samePoint(front, s)) {
        const seg = pool.splice(i, 1)[0];
        chain.unshift({ sel: seg.sel, coords: [...seg.coords].reverse() });
      } else {
        continue;
      }
      extended = true;
      break;
    }
  }
  return chain.concat(pool);
}

// Concatenate the oriented chain into a single coordinate array suitable for one
// LineString, dropping the duplicate vertex shared between consecutive segments,
// and return the total ground length in meters (the denominator for converting
// the pulse's meter-based parameters into line-progress fractions).
export function mergedPulseLine(selections: TrailSelection[]): {
  coords: number[][];
  lengthM: number;
} {
  const chain = chainSegments(selections);
  const coords: number[][] = [];
  for (const { coords: segCoords } of chain) {
    if (segCoords.length === 0) continue;
    // Skip the first vertex if it duplicates the running tail (shared endpoint).
    const start =
      coords.length > 0 && samePoint(coords[coords.length - 1], segCoords[0])
        ? 1
        : 0;
    for (let i = start; i < segCoords.length; i++) coords.push(segCoords[i]);
  }

  let lengthM = 0;
  for (let i = 1; i < coords.length; i++)
    lengthM += haversineMeters(coords[i - 1], coords[i]);

  return { coords, lengthM };
}
