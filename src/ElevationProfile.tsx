import { useMemo, useState } from "react";

export type TrailSelection = {
  name: string;
  seg: number;
  // [lon, lat, elevation] vertices (LineString Z from trails.geojson)
  coords: number[][];
};

const W = 320;
const H = 170;
const PAD = { top: 12, right: 14, bottom: 26, left: 48 };

type UnitSystem = "imperial" | "metric";

// Internal geometry is metres; these describe how to display each axis. `step`
// is the spacing of the grey y-axis reference lines, in the display unit.
const UNITS: Record<
  UnitSystem,
  {
    elev: { factor: number; step: number; label: string };
    dist: { factor: number; label: string };
  }
> = {
  imperial: {
    elev: { factor: 3.28084, step: 500, label: "ft" },
    dist: { factor: 1 / 1609.344, label: "mi" },
  },
  metric: {
    elev: { factor: 1, step: 100, label: "m" },
    dist: { factor: 1 / 1000, label: "km" },
  },
};

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
  const [unit, setUnit] = useState<UnitSystem>("imperial");

  const { plotted, minE, maxE, xMax } = useMemo(() => {
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
    return { plotted, minE, maxE, xMax };
  }, [selections]);

  const u = UNITS[unit];

  // Distances are converted from metres; elevations are formatted as whole
  // numbers in the active unit.
  const fmtDist = (m: number) =>
    `${(m * u.dist.factor).toFixed(2)} ${u.dist.label}`;
  const fmtElev = (m: number) => Math.round(m * u.elev.factor);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Y-axis bounds, in the display unit, snapped to whole `step` increments.
  const step = u.elev.step;
  const yMin = Math.floor((minE * u.elev.factor) / step) * step;
  const yMax = Math.max(
    yMin + step,
    Math.ceil((maxE * u.elev.factor) / step) * step,
  );

  const sx = (d: number) => PAD.left + (d / xMax) * plotW;
  // syDisp maps an already-converted display elevation; sy converts metres.
  const syDisp = (e: number) =>
    PAD.top + (1 - (e - yMin) / (yMax - yMin)) * plotH;
  const sy = (e: number) => syDisp(e * u.elev.factor);

  const refLines: number[] = [];
  for (let e = yMin; e <= yMax; e += step) refLines.push(e);

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
      <div className="elev-unit-toggle" role="group" aria-label="Units">
        <button
          type="button"
          className={unit === "imperial" ? "active" : ""}
          aria-pressed={unit === "imperial"}
          onClick={() => setUnit("imperial")}
        >
          mi/ft
        </button>
        <button
          type="button"
          className={unit === "metric" ? "active" : ""}
          aria-pressed={unit === "metric"}
          onClick={() => setUnit("metric")}
        >
          km/m
        </button>
      </div>
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
              y1={syDisp(e)}
              x2={PAD.left + plotW}
              y2={syDisp(e)}
              className="elev-gridline"
            />
            <text x={PAD.left - 6} y={syDisp(e) + 3} className="elev-ytick">
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
          {fmtDist(xMax)}
        </text>
        <text
          className="elev-axis-label"
          transform={`translate(7, ${PAD.top + plotH / 2}) rotate(-90)`}
        >
          {u.elev.label}
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
              {fmtDist(p.length)} · ↑{fmtElev(p.gain)} ↓
              {fmtElev(p.loss)} {u.elev.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
