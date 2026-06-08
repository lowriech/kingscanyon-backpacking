import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { ExpressionSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { cogProtocol } from "@geomatico/maplibre-cog-protocol";
import {
  KINGS_CANYON,
  DEFAULT_EXAGGERATION,
  mapStyle,
} from "./mapConfig";
import { MINERAL_KING, RANGER_STATION } from "./mineralKing";
import { projectBoundsPolygon } from "./projectBounds";
import ElevationProfile, { type TrailSelection } from "./ElevationProfile";

// Stream the locally-baked NAIP Cloud-Optimized GeoTIFFs tile-by-tile straight
// from public/naip/ (see scripts/bake_naip.py) via the cog:// protocol. The
// imagery is split into a grid of <100 MB COGs; tiles.json lists them.
maplibregl.addProtocol("cog", cogProtocol);

// Resolve a public/ asset against Vite's base path so the app works both at the
// dev root ("/") and under the GitHub Pages project subpath
// ("/kingscanyon-backpacking/"). BASE_URL always carries a trailing slash, so
// asset paths are passed in relative (no leading slash).
const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`;

const NAIP_MANIFEST = asset("naip/tiles.json");
const NAIP_ATTRIBUTION = "Imagery &copy; USGS NAIP / The National Map";

// A clicked trail piece is keyed by its Overture id + split index.
const trailKey = (id: unknown, seg: unknown) => `${id}#${seg}`;

const ROUTE_TRAIL_NAMES = [
  "Farewell Gap - Franklin Lakes Trail",
  "Franklin Pass Trail",
  "Soda Creek Trail",
  "Lost Canyon Trail",
  "Monarch Lakes Trail",
];

const ROUTE_TRAIL_COLOR = "#4de3ff";
const TRAIL_COLOR = "#ff8a3d";
const HOVER_COLOR = "#ffe08a";
const SELECT_COLOR = "#ff2e63";

// Return FRESH expression arrays per call: MapLibre mutates expression arrays
// in place while parsing, so a shared reference reused across paint properties
// gets corrupted and silently stops reacting to feature-state.
const isSelected = (): ExpressionSpecification => [
  "boolean",
  ["feature-state", "selected"],
  false,
];
const isHovered = (): ExpressionSpecification => [
  "boolean",
  ["feature-state", "hover"],
  false,
];

// Georeferenced trip photo (GPS pulled from IMG_2126.HEIC EXIF)
const TRIP_PHOTO = {
  src: asset("photo-IMG_2126.jpg"),
  coordinates: [-118.5962216666667, 36.56911333333333] as [number, number],
  title: "On the trail",
  caption: "Kings Canyon backcountry · Jul 7, 2025 · 36.5691°N, 118.5962°W",
};

const routeTrailExpression = (): ExpressionSpecification => [
  "in",
  ["get", "name"],
  ["literal", ROUTE_TRAIL_NAMES],
];

const LAYER_GROUPS = {
  // NAIP layer ids are discovered from the manifest at runtime (see
  // naipLayerIdsRef), so the static group is empty.
  naip: [] as string[],
  bounds: ["project-bounds-fill", "project-bounds-outline"],
  trails: ["trails-casing", "trails-line", "trails-label"],
  peaks: ["peaks-circle", "peaks-label"],
  passes: ["passes-circle", "passes-label"],
  water: [
    "lakes-fill",
    "lakes-outline",
    "lakes-label",
    "rivers-line",
    "rivers-label",
  ],
} as const;

type LayerGroup = keyof typeof LAYER_GROUPS;

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Full LineString Z geometries keyed by trailKey() — rendered features get
  // tile-clipped and drop the elevation ordinate, so we look them up here.
  const trailGeomRef = useRef<Map<string, number[][]>>(new Map());
  // Selected trail pieces keyed by their (generated) feature id; mirrored into
  // `trails` state for the elevation panel and into feature-state for styling.
  const selectionRef = useRef<Map<number, TrailSelection>>(new Map());
  const hoveredRef = useRef<number | null>(null);
  // NAIP overlay layer ids (one raster layer per COG tile from the manifest)
  // and the desired on/off state, mirrored so layers added asynchronously after
  // the manifest loads pick up the latest toggle.
  const naipLayerIdsRef = useRef<string[]>([]);
  const naipVisibleRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [trails, setTrails] = useState<TrailSelection[]>([]);
  const [exaggeration, setExaggeration] = useState(DEFAULT_EXAGGERATION);
  const [visible, setVisible] = useState<Record<LayerGroup, boolean>>({
    naip: false,
    bounds: true,
    trails: true,
    peaks: true,
    passes: true,
    water: true,
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: mapStyle,
      center: KINGS_CANYON.center,
      zoom: KINGS_CANYON.zoom,
      pitch: KINGS_CANYON.pitch,
      bearing: KINGS_CANYON.bearing,
      maxPitch: 85,
      hash: true,
    });
    mapRef.current = map;
    (window as unknown as { __map: maplibregl.Map; __naipIds: string[] }).__map =
      map;
    (window as unknown as { __naipIds: string[] }).__naipIds =
      naipLayerIdsRef.current;

    // Shift is our multi-select modifier; free it from MapLibre's box-zoom,
    // which otherwise swallows the Shift+click before the layer handler runs.
    map.boxZoom.disable();

    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      "top-right"
    );
    map.addControl(new maplibregl.FullscreenControl(), "top-right");
    map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 120, unit: "imperial" }),
      "bottom-right"
    );

    map.on("load", () => {
      // NAIP aerial imagery overlay: one raster layer per baked COG tile, off by
      // default. Each tile sits just below the water overlay (added next) so
      // trails, water, and labels stay readable when it's toggled on.
      fetch(NAIP_MANIFEST)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((m: { tiles?: string[] }) => {
          const base = `${window.location.origin}${import.meta.env.BASE_URL}`;
          for (const [idx, path] of (m.tiles ?? []).entries()) {
            const id = `naip-${idx}`;
            if (map.getSource(id)) continue;
            map.addSource(id, {
              type: "raster",
              url: `cog://${base}${path}`,
              tileSize: 256,
              attribution: NAIP_ATTRIBUTION,
            });
            map.addLayer(
              {
                id,
                type: "raster",
                source: id,
                layout: {
                  visibility: naipVisibleRef.current ? "visible" : "none",
                },
                paint: { "raster-opacity": 1 },
              },
              map.getLayer("lakes-fill") ? "lakes-fill" : undefined
            );
            naipLayerIdsRef.current.push(id);
          }
        })
        .catch(() => undefined);

      // Water: lakes (polygons) + rivers (lines), drawn beneath other overlays
      map.addSource("lakes", {
        type: "geojson",
        data: asset("lakes.geojson"),
        attribution: "Water &copy; Overture Maps / OpenStreetMap",
      });
      map.addLayer({
        id: "lakes-fill",
        type: "fill",
        source: "lakes",
        paint: { "fill-color": "#3d83c4", "fill-opacity": 0.45 },
      });
      map.addLayer({
        id: "lakes-outline",
        type: "line",
        source: "lakes",
        paint: { "line-color": "#bfe0ff", "line-width": 1 },
      });
      // Lake names placed on a center point inside each lake polygon
      map.addSource("lakeLabels", {
        type: "geojson",
        data: asset("lakes-points.geojson"),
      });
      map.addLayer({
        id: "lakes-label",
        type: "symbol",
        source: "lakeLabels",
        minzoom: 11,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
        },
        paint: {
          "text-color": "#dff1ff",
          "text-halo-color": "#06243a",
          "text-halo-width": 1.4,
        },
      });
      map.addSource("rivers", {
        type: "geojson",
        data: asset("rivers.geojson"),
        attribution: "Water &copy; Overture Maps / OpenStreetMap",
      });
      map.addLayer({
        id: "rivers-line",
        type: "line",
        source: "rivers",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#5db4ff",
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.8, 16, 2.5],
        },
      });
      map.addLayer({
        id: "rivers-label",
        type: "symbol",
        source: "rivers",
        minzoom: 12.5,
        layout: {
          "symbol-placement": "line",
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "symbol-spacing": 400,
        },
        paint: {
          "text-color": "#cfeaff",
          "text-halo-color": "#06243a",
          "text-halo-width": 1.4,
        },
      });

      // Project bounding box (green) — sourced from scripts/bbox.json
      map.addSource("projectBounds", {
        type: "geojson",
        data: projectBoundsPolygon,
      });
      map.addLayer({
        id: "project-bounds-fill",
        type: "fill",
        source: "projectBounds",
        paint: { "fill-color": "#5fcf80", "fill-opacity": 0.06 },
      });
      map.addLayer({
        id: "project-bounds-outline",
        type: "line",
        source: "projectBounds",
        paint: {
          "line-color": "#5fcf80",
          "line-width": 3,
          "line-dasharray": [2, 1.5],
        },
      });

      // Overture trails (baked GeoJSON) — casing, line, and along-line labels
      map.addSource("trails", {
        type: "geojson",
        data: asset("trails.geojson"),
        // Auto-assign stable per-feature ids so we can drive hover/selected
        // styling and multi-select via feature-state.
        generateId: true,
        attribution: "Trails &copy; Overture Maps / OpenStreetMap",
      });
      map.addLayer({
        id: "trails-casing",
        type: "line",
        source: "trails",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "rgba(0,0,0,0.55)",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            [
              "case",
              isSelected(),
              6,
              isHovered(),
              5,
              ["case", routeTrailExpression(), 4, 2.5],
            ],
            16,
            [
              "case",
              isSelected(),
              11,
              isHovered(),
              9,
              ["case", routeTrailExpression(), 8, 6],
            ],
          ],
        },
      });
      map.addLayer({
        id: "trails-line",
        type: "line",
        source: "trails",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": [
            "case",
            isSelected(),
            SELECT_COLOR,
            isHovered(),
            HOVER_COLOR,
            routeTrailExpression(),
            ROUTE_TRAIL_COLOR,
            TRAIL_COLOR,
          ],
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            [
              "case",
              isSelected(),
              3.5,
              isHovered(),
              2.8,
              ["case", routeTrailExpression(), 2, 1],
            ],
            16,
            [
              "case",
              isSelected(),
              6.5,
              isHovered(),
              5,
              ["case", routeTrailExpression(), 4.5, 3],
            ],
          ],
        },
      });
      map.addLayer({
        id: "trails-label",
        type: "symbol",
        source: "trails",
        minzoom: 12,
        layout: {
          "symbol-placement": "line",
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 12,
          "text-max-angle": 40,
          "symbol-spacing": 350,
        },
        paint: {
          "text-color": [
            "case",
            routeTrailExpression(),
            ROUTE_TRAIL_COLOR,
            "#ffffff",
          ],
          "text-halo-color": [
            "case",
            routeTrailExpression(),
            "#001f2a",
            "#1a1300",
          ],
          "text-halo-width": 1.6,
        },
      });

      // Cache full LineString Z geometries for elevation profiles on click.
      fetch(asset("trails.geojson"))
        .then((r) => r.json())
        .then((fc: GeoJSON.FeatureCollection) => {
          const lookup = trailGeomRef.current;
          for (const f of fc.features) {
            const g = f.geometry;
            if (g.type !== "LineString") continue;
            const p = f.properties ?? {};
            lookup.set(trailKey(p.id, p.seg), g.coordinates as number[][]);
          }
        })
        .catch(() => undefined);

      const setHover = (id: number | null) => {
        const prev = hoveredRef.current;
        if (prev === id) return;
        if (prev != null)
          map.setFeatureState({ source: "trails", id: prev }, { hover: false });
        if (id != null)
          map.setFeatureState({ source: "trails", id }, { hover: true });
        hoveredRef.current = id;
        // setFeatureState coalesces the change but doesn't always kick the
        // render loop until the next camera move, so force a repaint.
        map.triggerRepaint();
      };

      map.on("mousemove", "trails-line", (e) => {
        map.getCanvas().style.cursor = "pointer";
        const id = e.features?.[0]?.id;
        if (typeof id === "number") setHover(id);
      });
      map.on("mouseleave", "trails-line", () => {
        map.getCanvas().style.cursor = "";
        setHover(null);
      });

      map.on("click", "trails-line", (e) => {
        const f = e.features?.[0];
        if (f == null || typeof f.id !== "number") return;
        const p = f.properties ?? {};
        const coords = trailGeomRef.current.get(trailKey(p.id, p.seg));
        if (!coords || coords.length < 2) return;

        const id = f.id;
        const sel: TrailSelection = {
          name: p.name ?? "Trail",
          seg: Number(p.seg) || 0,
          coords,
        };
        const picked = selectionRef.current;
        const additive = (e.originalEvent as MouseEvent).shiftKey;

        if (additive) {
          // Shift-click toggles this segment in/out of the selection.
          if (picked.has(id)) {
            picked.delete(id);
            map.setFeatureState({ source: "trails", id }, { selected: false });
          } else {
            picked.set(id, sel);
            map.setFeatureState({ source: "trails", id }, { selected: true });
          }
        } else {
          // Plain click replaces the selection with just this segment.
          for (const prev of picked.keys())
            map.setFeatureState(
              { source: "trails", id: prev },
              { selected: false }
            );
          picked.clear();
          picked.set(id, sel);
          map.setFeatureState({ source: "trails", id }, { selected: true });
        }
        map.triggerRepaint();
        setTrails(Array.from(picked.values()));
      });

      // Clicking off any segment (no trail under the cursor) without Shift
      // clears the whole selection buffer.
      map.on("click", (e) => {
        if ((e.originalEvent as MouseEvent).shiftKey) return;
        const hits = map.queryRenderedFeatures(e.point, {
          layers: ["trails-line"],
        });
        if (hits.length > 0) return;
        for (const prev of selectionRef.current.keys())
          map.setFeatureState(
            { source: "trails", id: prev },
            { selected: false }
          );
        selectionRef.current.clear();
        map.triggerRepaint();
        setTrails([]);
      });

      // Peaks + passes (points with elevation labels)
      map.addSource("topo", { type: "geojson", data: asset("topo-points.geojson") });

      const elevLabel: ExpressionSpecification = [
        "case",
        ["has", "elevation"],
        ["concat", ["get", "name"], "\n", ["to-string", ["get", "elevation"]], " m"],
        ["get", "name"],
      ];

      map.addLayer({
        id: "passes-circle",
        type: "circle",
        source: "topo",
        filter: ["==", ["get", "kind"], "pass"],
        paint: {
          "circle-radius": 3.5,
          "circle-color": "#7ec8ff",
          "circle-stroke-color": "#06243a",
          "circle-stroke-width": 1.5,
        },
      });
      map.addLayer({
        id: "peaks-circle",
        type: "circle",
        source: "topo",
        filter: ["==", ["get", "kind"], "peak"],
        paint: {
          "circle-radius": 3.5,
          "circle-color": "#ff8a3d",
          "circle-stroke-color": "#2a1500",
          "circle-stroke-width": 1.5,
        },
      });
      map.addLayer({
        id: "passes-label",
        type: "symbol",
        source: "topo",
        filter: ["==", ["get", "kind"], "pass"],
        minzoom: 11,
        layout: {
          "text-field": elevLabel,
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 0.9],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#d8efff",
          "text-halo-color": "#06243a",
          "text-halo-width": 1.4,
        },
      });
      map.addLayer({
        id: "peaks-label",
        type: "symbol",
        source: "topo",
        filter: ["==", ["get", "kind"], "peak"],
        minzoom: 11,
        layout: {
          "text-field": elevLabel,
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 0.9],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#ffe7d1",
          "text-halo-color": "#2a1500",
          "text-halo-width": 1.4,
        },
      });

      // Ranger station marker
      const el = document.createElement("div");
      el.className = "ranger-marker";
      el.title = RANGER_STATION.name;

      new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat(RANGER_STATION.coordinates)
        .setPopup(
          new maplibregl.Popup({ offset: 18, closeButton: false }).setHTML(
            `<strong>${RANGER_STATION.name}</strong>`
          )
        )
        .addTo(map);

      // Georeferenced trip photo marker — click to open the photo viewer
      const photoEl = document.createElement("button");
      photoEl.className = "photo-marker";
      photoEl.type = "button";
      photoEl.title = TRIP_PHOTO.title;
      const photoImg = document.createElement("span");
      photoImg.className = "photo-marker-img";
      photoImg.style.backgroundImage = `url(${TRIP_PHOTO.src})`;
      photoEl.appendChild(photoImg);
      photoEl.addEventListener("click", (e) => {
        e.stopPropagation();
        setPhotoOpen(true);
      });

      new maplibregl.Marker({ element: photoEl, anchor: "bottom" })
        .setLngLat(TRIP_PHOTO.coordinates)
        .addTo(map);

      setLoading(false);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const onExaggerationChange = (value: number) => {
    setExaggeration(value);
    mapRef.current?.setTerrain({
      source: "terrainDEM",
      exaggeration: value,
    });
  };

  const flyToOverlook = () => {
    mapRef.current?.flyTo({
      center: KINGS_CANYON.center,
      zoom: KINGS_CANYON.zoom,
      pitch: KINGS_CANYON.pitch,
      bearing: KINGS_CANYON.bearing,
      duration: 2500,
      essential: true,
    });
  };

  const toggleGroup = (group: LayerGroup, on: boolean) => {
    setVisible((prev) => ({ ...prev, [group]: on }));
    if (group === "naip") naipVisibleRef.current = on;
    const map = mapRef.current;
    if (!map) return;
    const v = on ? "visible" : "none";
    const ids = group === "naip" ? naipLayerIdsRef.current : LAYER_GROUPS[group];
    for (const id of ids) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
    }
  };

  const clearSelection = () => {
    const map = mapRef.current;
    if (map) {
      for (const id of selectionRef.current.keys())
        map.setFeatureState({ source: "trails", id }, { selected: false });
      map.triggerRepaint();
    }
    selectionRef.current.clear();
    setTrails([]);
  };

  const flyToMineralKing = () => {
    mapRef.current?.flyTo({
      center: MINERAL_KING.center,
      zoom: MINERAL_KING.zoom,
      pitch: MINERAL_KING.pitch,
      bearing: MINERAL_KING.bearing,
      duration: 2500,
      essential: true,
    });
  };

  return (
    <>
      <div ref={containerRef} id="map" />

      {loading && <div className="loading">Loading terrain…</div>}

      {photoOpen && (
        <div id="photo-viewer" className="panel">
          <button
            className="photo-close"
            type="button"
            aria-label="Close photo"
            onClick={() => setPhotoOpen(false)}
          >
            ×
          </button>
          <img src={TRIP_PHOTO.src} alt={TRIP_PHOTO.title} />
          <p className="photo-caption">{TRIP_PHOTO.caption}</p>
        </div>
      )}

      {trails.length > 0 && (
        <ElevationProfile selections={trails} onClose={clearSelection} />
      )}

      <div id="title" className="panel">
        <h1>Kings Canyon</h1>
        <p>
          3D elevation terrain over Kings Canyon National Park, California. Drag
          to pan, right-drag to tilt &amp; rotate, scroll to zoom.
        </p>
      </div>

      <div id="controls" className="panel">
        <div className="control-block">
          <div className="row">
            <label htmlFor="exaggeration">Terrain exaggeration</label>
            <span className="value">{exaggeration.toFixed(1)}×</span>
          </div>
          <input
            id="exaggeration"
            type="range"
            min={0}
            max={4}
            step={0.1}
            value={exaggeration}
            onChange={(e) => onExaggerationChange(parseFloat(e.target.value))}
          />
        </div>

        <div className="control-block">
          <label className="toggle">
            <input
              type="checkbox"
              checked={visible.naip}
              onChange={(e) => toggleGroup("naip", e.target.checked)}
            />
            <span>NAIP aerial imagery</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={visible.bounds}
              onChange={(e) => toggleGroup("bounds", e.target.checked)}
            />
            <span>Project bounding box</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={visible.trails}
              onChange={(e) => toggleGroup("trails", e.target.checked)}
            />
            <span>Trails</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={visible.peaks}
              onChange={(e) => toggleGroup("peaks", e.target.checked)}
            />
            <span>Peaks</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={visible.passes}
              onChange={(e) => toggleGroup("passes", e.target.checked)}
            />
            <span>Passes</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={visible.water}
              onChange={(e) => toggleGroup("water", e.target.checked)}
            />
            <span>Lakes &amp; rivers</span>
          </label>
          <div className="legend">
            <span className="legend-swatch route" />
            <span>Trip route trails</span>
          </div>
        </div>

        <div className="control-block">
          <button className="flyto" onClick={flyToOverlook}>
            Fly to canyon overlook
          </button>
          <button className="flyto" onClick={flyToMineralKing}>
            Fly to Mineral King
          </button>
        </div>
      </div>
    </>
  );
}
