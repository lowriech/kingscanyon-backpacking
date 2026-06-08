# Kings Canyon Backpacking — Project Guide

A MapLibre GL + React + TypeScript (Vite, Bun) app showing 3D terrain over Kings
Canyon, with trail and topographic overlays baked from Overture Maps.

## Project bounding box

This is the canonical domain for all fetched map data:

| Edge | Value |
|---|---|
| South (min lat) | `36.2682` |
| West (min lon) | `-118.8288` |
| North (max lat) | `36.7708` |
| East (max lon) | `-118.2699` | 

Corners (lat, lon): `36.2682, -118.8288` (SW) → `36.7708, -118.2699` (NE).

**Single source of truth:** `scripts/bbox.json`. Change it there, then refetch.
Keep this table and `scripts/bbox.json` in sync.

## Refetching data when the bounding box changes

The pipeline has three stages: **ingest** Overture into GeoParquet under `data/`
(a gitignored build dir), **prep** trails into elevation-annotated 3D geometry,
then **bake** the client `public/*.geojson`. To refetch:

```bash
make data             # ingest -> prep -> bake everything + regenerate summaries
make data-trails      # ingest trails        -> data/trails.parquet
make data-topo        # ingest peaks/passes/lakes/rivers -> data/*.parquet
make data-dem         # elevation GeoTIFF (USGS 3DEP)    -> public/dem.tif
make data-naip        # NAIP aerial imagery COG tiles (USGS) -> public/naip/
make data-trails-prep # split @1km + LineString Z + DEM elevation -> data/trails-3d.parquet
make data-bake        # convert data/*.parquet           -> public/*.geojson
```

`make data` assumes `public/dem.tif` already exists; rerun `make data-dem` when
the bounding box changes (the DEM fetch is slow). `make data-naip` is likewise a
slow standalone fetch; rerun it when the bbox changes. All Python work runs through
[`uv`](https://docs.astral.sh/uv/); dependencies are declared in `pyproject.toml`
(DuckDB for Overture; xarray + rioxarray for the DEM; GeoPandas + Shapely for the
prep step). The Make targets call `uv run python scripts/…`, which transparently
creates/syncs the `.venv` on first use. `make data` runs the bake scripts and
regenerates `TRAILS_SUMMARY.md` / `TOPO_SUMMARY.md`.

## Data sources (all Overture Maps, ODbL)

Each row is ingested to `data/<name>.parquet` (GeoParquet) and then baked to the
client GeoJSON below. Trails are additionally split + elevation-annotated into
`data/trails-3d.parquet` (LineString Z) before baking, so `public/trails.geojson`
carries per-vertex elevation.

| Client file | Ingest parquet | Overture source | Geometry | Map layers |
|---|---|---|---|---|
| `public/trails.geojson` | `trails.parquet` -> `trails-3d.parquet` | transportation `segment` (path/footway/track/…) | LineString Z | `trails-*` |
| `public/topo-points.geojson` | `topo-points.parquet` | base `land` `physical/peak` + `physical/saddle` | points | `peaks-*`, `passes-*` |
| `public/lakes.geojson` | `lakes.parquet` | base `water` `lake` | polygons | `lakes-fill`, `lakes-outline` |
| `public/lakes-points.geojson` | `lakes-points.parquet` | base `water` `lake` (center point) | points | `lakes-label` |
| `public/rivers.geojson` | `rivers.parquet` | base `water` `river` | lines | `rivers-line`, `rivers-label` |

Elevation (`public/dem.tif`) is baked separately from USGS 3DEP by
`scripts/bake_dem.py` (`make data-dem`) and is the elevation source for the
trails prep step.

NAIP aerial imagery is baked separately from USGS NAIP / The National Map by
`scripts/bake_naip.py` (`make data-naip`) into a grid of JPEG-compressed
Cloud-Optimized GeoTIFFs under `public/naip/`, listed in `public/naip/tiles.json`.
NAIP's usable resolution here is ~0.6 m, far finer than a single sub-100 MB file
can hold for this box, so the imagery is sampled at `NAIP_MPP` m/px in EPSG:3857
(default 1.25 m/px ~= 1 m ground) and split into enough tiles that each COG stays
under GitHub's 100 MB limit (`NAIP_TILE_MPX` caps megapixels per tile). The
client reads the manifest and adds one toggleable `naip-*` raster layer per tile,
streaming each COG tile-by-tile via the `cog://` protocol
(`@geomatico/maplibre-cog-protocol`). Output is EPSG:3857 because that protocol
only reads Web Mercator COGs.

Scripts: `scripts/bake_trails.py`, `scripts/bake_topo.py`, `scripts/bake_dem.py`,
`scripts/bake_trails_prep.py`, `scripts/bake_geojson.py`,
`scripts/write_summaries.py`, shared helpers in `scripts/overture_common.py`.

## Running the app

```bash
make start   # bun install + vite dev server on http://127.0.0.1:5173
make stop
```
