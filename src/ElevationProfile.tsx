import { useMemo } from "react";

export type TrailSelection = {
  name: string;
  seg: number;
  // [lon, lat, elevation] vertices (LineString Z from trails.geojson)
  coords: number[][];
};

const W = 320;
const H = 170;
const PAD = { top: 12, right: 14, bottom: 26, left: 42 };
const STEP_M = 100; // grey y-axis reference lines every 100 m

// Endpoint match tolerances for chaining segments (xyz at the ends).
const EPS_DEG = 1e-5; // ~1 m in lon/lat
const EPS_ELEV = 2; // meters

// Distinct colors for chained profiles (cycled when there are many).
const PALETTE = [
  "#ff8a3d",
  "#4de3ff",
  "#ffd23f",
  "#5fcf80",
  "#ff6fb5",
  "#b08aff",
];

export const profileColor = (i: number) => PALETTE[i % PALETTE.length];

function haversineMeters(a: number[], b: number[]): number {
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

function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function samePoint(a: number[], b: number[]): boolean {
  return (
    Math.abs(a[0] - b[0]) < EPS_DEG &&
    Math.abs(a[1] - b[1]) < EPS_DEG &&
    Math.abs((a[2] ?? 0) - (b[2] ?? 0)) < EPS_ELEV
  );
}

type Oriented = { sel: TrailSelection; coords: number[][] };

// Greedily chain segments so consecutive ones share an endpoint (xyz),
// reversing where needed; unmatched segments are appended in place.
function chainSegments(selections: TrailSelection[]): Oriented[] {
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

type Plotted = {
  sel: TrailSelection;
  pts: { d: number; e: number }[];
  start: number;
  length: number;
  gain: number;
  loss: number;
};

export default function ElevationProfile({
  selections,
  onClose,
}: {
  selections: TrailSelection[];
  onClose: () => void;
}) {
  const { plotted, yMin, yMax, xMax } = useMemo(() => {
    const chain = chainSegments(selections);
    const plotted: Plotted[] = [];
    let cursor = 0;
    let minE = Infinity;
    let maxE = -Infinity;
    for (const { sel, coords } of chain) {
      const pts: { d: number; e: number }[] = [];
      let acc = 0;
      let gain = 0;
      let loss = 0;
      for (let i = 0; i < coords.length; i++) {
        if (i > 0) {
          acc += haversineMeters(coords[i - 1], coords[i]);
          const dz = (coords[i][2] ?? 0) - (coords[i - 1][2] ?? 0);
          if (dz > 0) gain += dz;
          else loss -= dz;
        }
        const e = coords[i][2] ?? 0;
        minE = Math.min(minE, e);
        maxE = Math.max(maxE, e);
        pts.push({ d: cursor + acc, e });
      }
      plotted.push({ sel, pts, start: cursor, length: acc, gain, loss });
      cursor += acc;
    }
    const xMax = Math.max(1, cursor);
    const yMin = Math.floor(minE / STEP_M) * STEP_M;
    const yMax = Math.max(yMin + STEP_M, Math.ceil(maxE / STEP_M) * STEP_M);
    return { plotted, yMin, yMax, xMax };
  }, [selections]);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const sx = (d: number) => PAD.left + (d / xMax) * plotW;
  const sy = (e: number) => PAD.top + (1 - (e - yMin) / (yMax - yMin)) * plotH;

  const refLines: number[] = [];
  for (let e = yMin; e <= yMax; e += STEP_M) refLines.push(e);

  return (
    <div id="elevation-viewer" className="panel">
      <button
        className="photo-close"
        type="button"
        aria-label="Close elevation profile"
        onClick={onClose}
      >
        ×
      </button>
      <svg
        className="elev-graph"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Elevation profile for ${selections.length} segment(s)`}
      >
        {refLines.map((e) => (
          <g key={e}>
            <line
              x1={PAD.left}
              y1={sy(e)}
              x2={PAD.left + plotW}
              y2={sy(e)}
              className="elev-gridline"
            />
            <text x={PAD.left - 6} y={sy(e) + 3} className="elev-ytick">
              {e}
            </text>
          </g>
        ))}

        {plotted.map((p, i) => (
          <polyline
            key={i}
            points={p.pts
              .map((pt) => `${sx(pt.d).toFixed(1)},${sy(pt.e).toFixed(1)}`)
              .join(" ")}
            fill="none"
            stroke={profileColor(i)}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        <text x={PAD.left} y={H - 8} className="elev-xtick elev-x-start">
          0
        </text>
        <text x={PAD.left + plotW} y={H - 8} className="elev-xtick elev-x-end">
          {formatDist(xMax)}
        </text>
        <text x={12} y={PAD.top - 1} className="elev-axis-label">
          m
        </text>
      </svg>

      <div className="elev-legend">
        {plotted.map((p, i) => (
          <div className="elev-legend-row" key={`${p.sel.name}#${p.sel.seg}-${i}`}>
            <span
              className="elev-legend-swatch"
              style={{ background: profileColor(i) }}
            />
            <span className="elev-legend-name">{p.sel.name}</span>
            <span className="elev-legend-stats">
              {formatDist(p.length)} · ↑{Math.round(p.gain)} ↓
              {Math.round(p.loss)} m
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
