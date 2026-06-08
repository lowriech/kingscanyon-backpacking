#!/usr/bin/env python3
"""Prepare elevation-annotated 3D trails into data/trails-3d.parquet.

Assumes the ingest layer has already run: Overture trails live in
`data/trails.parquet` (see `bake_trails.py`) and the DEM lives in
`public/dem.tif` (see `bake_dem.py`).

Pipeline, per trail segment:
  1. Reproject to a metric CRS (UTM 11N) so distances are in meters.
  2. Split the line into pieces of at most 1 km.
  3. Densify each piece so vertices sit ~every 10 m (`segmentize`).
  4. Sample the DEM at every vertex (bilinear) and emit a LineString Z whose
     third ordinate is the elevation in meters.

Output is GeoParquet (LineString Z, EPSG:4326); `bake_geojson.py` turns it into
the client-facing `public/trails.geojson`.
"""
import math
import os
import sys

import geopandas as gpd
import numpy as np
import rioxarray  # noqa: F401 - registers the .rio xarray accessor
import xarray as xr
from shapely.geometry import LineString
from shapely.ops import substring

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from overture_common import DATA, PUBLIC  # noqa: E402

SPLIT_M = 1000.0       # split trails into <= 1 km pieces
STEP_M = 10.0          # vertex spacing for elevation annotation
METRIC_CRS = "EPSG:32611"  # UTM zone 11N — covers the Kings Canyon bbox
TRAILS_IN = "trails.parquet"
TRAILS_OUT = "trails-3d.parquet"
DEM = "dem.tif"


def open_dem():
    """Open the DEM as a 2D (y, x) DataArray in EPSG:4326 with NaN nodata."""
    path = os.path.join(PUBLIC, DEM)
    if not os.path.exists(path):
        sys.exit(f"  missing {path} — run `make data-dem` first")
    da = rioxarray.open_rasterio(path, masked=True).squeeze(drop=True)
    if da.rio.crs is not None and da.rio.crs.to_epsg() != 4326:
        da = da.rio.reproject("EPSG:4326")
    # interp() needs monotonically increasing coordinates.
    return da.sortby("x").sortby("y")


def sample_elevations(dem, lons, lats):
    """Bilinearly sample the DEM at the given lon/lat points (meters)."""
    xs = xr.DataArray(np.asarray(lons, dtype="float64"), dims="pts")
    ys = xr.DataArray(np.asarray(lats, dtype="float64"), dims="pts")
    z = dem.interp(x=xs, y=ys, method="linear").values.astype("float64")
    if np.isnan(z).any():  # fall back to nearest at the raster edges
        near = dem.sel(x=xs, y=ys, method="nearest").values.astype("float64")
        z = np.where(np.isnan(z), near, z)
    return np.nan_to_num(z, nan=0.0)


def split_and_densify(geom):
    """Yield <=1 km, ~10 m-densified LineString pieces (metric CRS) of `geom`."""
    parts = geom.geoms if geom.geom_type == "MultiLineString" else [geom]
    for part in parts:
        if part.is_empty or part.geom_type != "LineString":
            continue
        length = part.length
        n = max(1, math.ceil(length / SPLIT_M))
        for k in range(n):
            piece = substring(part, k * SPLIT_M, min((k + 1) * SPLIT_M, length))
            if piece.is_empty or piece.geom_type != "LineString" or piece.length == 0:
                continue
            yield k, piece.segmentize(STEP_M)


def main():
    src = os.path.join(DATA, TRAILS_IN)
    if not os.path.exists(src):
        sys.exit(f"  missing {src} — run `make data-trails` first")

    print(f"Trails prep — split @ {SPLIT_M:.0f} m, annotate @ {STEP_M:.0f} m")
    gdf = gpd.read_parquet(src).to_crs(METRIC_CRS)
    dem = open_dem()

    # Pass 1: cut + densify every trail into metric pieces, keeping properties.
    props = {"name": [], "class": [], "id": [], "seg": [], "length_m": []}
    pieces_m = []
    names = gdf["name"].to_list()
    classes = gdf["class"].to_list()
    ids = gdf["id"].to_list()
    for name, cls, fid, geom in zip(names, classes, ids, gdf.geometry):
        if geom is None or geom.is_empty:
            continue
        for seg, piece in split_and_densify(geom):
            props["name"].append(name)
            props["class"].append(cls)
            props["id"].append(fid)
            props["seg"].append(seg)
            props["length_m"].append(round(piece.length, 1))
            pieces_m.append(piece)

    if not pieces_m:
        sys.exit("  no trail geometry to process")

    # Pass 2: reproject to lon/lat, sample elevation once, rebuild LineString Z.
    pieces_ll = gpd.GeoSeries(pieces_m, crs=METRIC_CRS).to_crs("EPSG:4326")
    coords = [list(g.coords) for g in pieces_ll]
    flat_lon = [x for cs in coords for (x, _y) in cs]
    flat_lat = [y for cs in coords for (_x, y) in cs]
    z = sample_elevations(dem, flat_lon, flat_lat)

    geoms_3d = []
    i = 0
    for cs in coords:
        geoms_3d.append(
            LineString([(x, y, round(float(z[i + j]), 1))
                        for j, (x, y) in enumerate(cs)])
        )
        i += len(cs)

    out = gpd.GeoDataFrame(props, geometry=geoms_3d, crs="EPSG:4326")
    os.makedirs(DATA, exist_ok=True)
    out_path = os.path.join(DATA, TRAILS_OUT)
    out.to_parquet(out_path)

    verts = len(flat_lon)
    km = round(sum(props["length_m"]) / 1000.0, 1)
    kb = round(os.path.getsize(out_path) / 1024, 1)
    print(f"  {TRAILS_OUT}: {len(out)} pieces, {verts} vertices, "
          f"~{km} km, {kb} KB")


if __name__ == "__main__":
    main()
