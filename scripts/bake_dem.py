#!/usr/bin/env python3
"""Fetch a digital elevation model (DEM) for the project bbox from USGS 3DEP.

Pulls seamless elevation from The National Map's `3DEPElevation` ImageServer
(`exportImage`) in tiles, mosaics them with rioxarray/xarray, then writes a
compressed Float32 GeoTIFF to `public/dem.tif`.

Several raster compressors are compared at build time and the smallest result
is kept, so the file stays comfortably under GitHub's 100 MB per-file limit.

Resolution defaults to 1/3 arc-second (~10 m) -- the standard seamless 3DEP
product. Override with `DEM_ARCSEC=1` (~30 m) for a much smaller file.

Source: USGS 3DEP (public domain). Clipped to scripts/bbox.json.
"""
import os
import shutil
import sys
import tempfile
import time
import urllib.parse
import urllib.request

import numpy as np
import rioxarray  # noqa: F401 - registers the .rio xarray accessor
from rioxarray.merge import merge_arrays

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from overture_common import PUBLIC, load_bbox  # noqa: E402

SERVICE = ("https://elevation.nationalmap.gov/arcgis/rest/services/"
           "3DEPElevation/ImageServer/exportImage")
TILE = 2048             # px per request side (service caps at 8000; small = fast)
RETRIES = 4             # per-tile attempts (service occasionally 504s)
NODATA = -999999.0
SIZE_LIMIT_MB = 100     # GitHub per-file hard limit
OUT = "dem.tif"

# Degrees per pixel for each supported 3DEP resolution.
ARCSEC_DEG = {
    "1/3": 1.0 / 10800.0,   # ~10 m  (seamless CONUS)
    "1": 1.0 / 3600.0,      # ~30 m
    "1/9": 1.0 / 32400.0,   # ~3 m   (only where available; large files)
}

# Compressors to compare. Float predictor (=3) helps a lot on terrain.
CANDIDATES = [
    {"compress": "zstd", "predictor": 3, "zstd_level": 22, "num_threads": "all_cpus"},
    {"compress": "deflate", "predictor": 3, "zlevel": 9, "num_threads": "all_cpus"},
    {"compress": "lzw", "predictor": 3},
]


def fetch_tile(west, south, east, north, cols, rows):
    """Download one bbox tile as a Float32 GeoTIFF (bytes) from 3DEP."""
    params = {
        "bbox": f"{west},{south},{east},{north}",
        "bboxSR": 4326,
        "imageSR": 4326,
        "size": f"{cols},{rows}",
        "format": "tiff",
        "pixelType": "F32",
        "noData": NODATA,
        "noDataInterpretation": "esriNoDataMatchAny",
        "interpolation": "RSP_BilinearInterpolation",
        "f": "image",
    }
    url = SERVICE + "?" + urllib.parse.urlencode(params)
    last = None
    for attempt in range(1, RETRIES + 1):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                data = r.read()
            if data[:2] not in (b"II", b"MM"):  # not a TIFF -> service error (JSON)
                raise RuntimeError("non-TIFF response: " +
                                   data[:300].decode("utf-8", "replace"))
            return data
        except Exception as e:  # noqa: BLE001 - retry transient 504s / resets
            last = e
            if attempt < RETRIES:
                time.sleep(2 * attempt)
    raise SystemExit(f"  tile failed after {RETRIES} attempts: {last}")


def fetch_mosaic(b, dpp, tmp):
    """Tile the bbox into <=TILE px requests, fetch each, and mosaic them.

    Returns a single seamless Float32 DataArray (band, y, x) with CRS + nodata.
    """
    cols = round((b["east"] - b["west"]) / dpp)
    rows = round((b["north"] - b["south"]) / dpp)
    nx = (cols + TILE - 1) // TILE
    ny = (rows + TILE - 1) // TILE
    print(f"  {cols}x{rows} px ({cols * rows / 1e6:.1f} Mpx) in {nx}x{ny} tiles ...")

    arrays = []
    n = 0
    for j in range(ny):
        y0, y1 = j * TILE, min((j + 1) * TILE, rows)
        # image row 0 is the north edge; geographic y decreases as row increases
        north_j = b["north"] - y0 * dpp
        south_j = b["north"] - y1 * dpp
        for i in range(nx):
            x0, x1 = i * TILE, min((i + 1) * TILE, cols)
            west_i = b["west"] + x0 * dpp
            east_i = b["west"] + x1 * dpp
            n += 1
            print(f"    tile {n}/{nx * ny} ({x1 - x0}x{y1 - y0}) ...")
            data = fetch_tile(west_i, south_j, east_i, north_j, x1 - x0, y1 - y0)
            path = os.path.join(tmp, f"tile_{j}_{i}.tif")
            with open(path, "wb") as f:
                f.write(data)
            arrays.append(rioxarray.open_rasterio(path))

    # .load() pulls every tile into memory so we can close the file-backed
    # source arrays before the temp dir disappears (avoids finalizer errors).
    merged = merge_arrays(arrays, nodata=NODATA).load()
    for a in arrays:
        a.close()
    merged = merged.rio.write_nodata(NODATA)
    return merged


def write_best(da, tmp):
    """Encode `da` with each candidate compressor; keep the smallest file."""
    opts = dict(driver="GTiff", dtype="float32", tiled=True,
                blockxsize=512, blockysize=512, BIGTIFF="IF_SAFER")
    best = None
    for comp in CANDIDATES:
        path = os.path.join(tmp, f"try_{comp['compress']}.tif")
        try:
            da.rio.to_raster(path, **opts, **comp)
        except Exception as e:  # compressor unavailable in this GDAL build
            print(f"    {comp['compress']:>8}: skipped ({e})")
            continue
        size = os.path.getsize(path)
        print(f"    {comp['compress']:>8} (predictor "
              f"{comp.get('predictor', 1)}): {size / 1e6:.1f} MB")
        if best is None or size < best[0]:
            best = (size, path, comp["compress"])
    if best is None:
        sys.exit("  no compressor produced output")
    return best


def main():
    b = load_bbox()
    arcsec = os.environ.get("DEM_ARCSEC", "1/3")
    if arcsec not in ARCSEC_DEG:
        sys.exit(f"DEM_ARCSEC must be one of {sorted(ARCSEC_DEG)}")
    dpp = ARCSEC_DEG[arcsec]

    print(f"DEM - bbox {b['west']},{b['south']} : {b['east']},{b['north']} "
          f"@ {arcsec} arc-second")
    os.makedirs(PUBLIC, exist_ok=True)
    out_path = os.path.join(PUBLIC, OUT)

    with tempfile.TemporaryDirectory(prefix="dem-") as tmp:
        da = fetch_mosaic(b, dpp, tmp)
        print("  comparing compressors:")
        _, best_path, label = write_best(da, tmp)
        shutil.copyfile(best_path, out_path)

    vals = da.values
    valid = vals[vals != NODATA]
    lo, hi = (float(valid.min()), float(valid.max())) if valid.size else (0.0, 0.0)
    mb = os.path.getsize(out_path) / 1e6
    with rioxarray.open_rasterio(out_path) as ds:
        h, w = ds.rio.height, ds.rio.width
        crs = ds.rio.crs
    print(f"  {OUT}: {w}x{h} px, {label}, {mb:.1f} MB, "
          f"elev {lo:.0f}-{hi:.0f} m, CRS {crs}")

    if mb >= SIZE_LIMIT_MB:
        sys.exit(f"  ERROR: {mb:.1f} MB exceeds the {SIZE_LIMIT_MB} MB limit; "
                 "rerun with DEM_ARCSEC=1")
    print(f"  OK: under {SIZE_LIMIT_MB} MB GitHub limit")


if __name__ == "__main__":
    main()
