#!/usr/bin/env python3
"""Fetch NAIP aerial imagery for the project bbox from USGS / The National Map.

Pulls natural-color (RGB) orthoimagery from the USGS `USGSNAIPImagery`
ImageServer (`exportImage`) and writes a grid of JPEG-compressed 8-bit
Cloud-Optimized GeoTIFFs (COGs) under `public/naip/`, plus a `tiles.json`
manifest the web client reads to add one raster layer per tile.

Why a grid? NAIP's usable source resolution here is ~0.6 m, far finer than the
~3 m a single sub-100 MB file can hold for this ~50x56 km box. The imagery is
sampled at `NAIP_MPP` meters/pixel in EPSG:3857 (default 1.25 m/px ~= 1 m on the
ground) and split into enough tiles that each COG stays under GitHub's 100 MB
per-file limit (`NAIP_TILE_MPX` caps megapixels per tile). The whole set is far
larger than 100 MB, but no single file is.

Output is EPSG:3857 (Web Mercator) because `@geomatico/maplibre-cog-protocol`
reads only 3857 COGs (it silently misreads a 4326 COG's degrees as meters), and
the service serves 3857 natively so no client-side reprojection is needed.

Source: USGS NAIP Imagery, The National Map (public domain). Clipped to
scripts/bbox.json.
"""
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import rioxarray  # noqa: F401 - registers the .rio xarray accessor
import rasterio
from rasterio.warp import transform_bounds
from rioxarray.merge import merge_arrays

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from overture_common import PUBLIC, load_bbox  # noqa: E402

SERVICE = ("https://imagery.nationalmap.gov/arcgis/rest/services/"
           "USGSNAIPImagery/ImageServer/exportImage")
REQ = 2048              # px/side per request (4000 reliably 504s; 2048 is safe)
WORKERS = int(os.environ.get("NAIP_WORKERS", "8"))  # concurrent downloads
RETRIES = 4             # per-request attempts (service occasionally 504s)
SIZE_LIMIT_MB = 100     # GitHub per-file hard limit
OUT_DIR = "naip"        # tiles + manifest live under public/naip/
MANIFEST = "tiles.json"

# JPEG quality ladder tried per output tile until one lands under the limit.
QUALITY_LADDER = [75, 65, 55, 45]


def fetch_request(xmin, ymin, xmax, ymax, cols, rows, tmp, name):
    """Download one <=4000px exportImage request (EPSG:3857) -> GeoTIFF path."""
    params = {
        "bbox": f"{xmin},{ymin},{xmax},{ymax}",
        "bboxSR": 3857,
        "imageSR": 3857,
        "size": f"{cols},{rows}",
        "bandIds": "0,1,2",          # natural-color RGB (drop NIR band)
        "format": "tiff",
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
            path = os.path.join(tmp, name)
            with open(path, "wb") as f:
                f.write(data)
            return path
        except Exception as e:  # noqa: BLE001 - retry transient 504s / resets
            last = e
            if attempt < RETRIES:
                time.sleep(2 * attempt)
    raise SystemExit(f"  request failed after {RETRIES} attempts: {last}")


def fetch_region(xmin, ymin, xmax, ymax, cols, rows, mpp, tmp, label):
    """Mosaic one output tile's extent from <=REQ px exportImage requests.

    Requests run concurrently (WORKERS threads); the service is the bottleneck,
    so this is dramatically faster than serial fetching. Returns an in-memory
    EPSG:3857 RGB DataArray (band, y, x).
    """
    nx = (cols + REQ - 1) // REQ
    ny = (rows + REQ - 1) // REQ
    jobs = []
    for j in range(ny):
        r0, r1 = j * REQ, min((j + 1) * REQ, rows)
        north_j = ymax - r0 * mpp           # image row 0 == north edge
        south_j = ymax - r1 * mpp
        for i in range(nx):
            c0, c1 = i * REQ, min((i + 1) * REQ, cols)
            jobs.append((xmin + c0 * mpp, south_j, xmin + c1 * mpp, north_j,
                         c1 - c0, r1 - r0, f"req_{j}_{i}.tif"))

    print(f"      {label}: {len(jobs)} requests x{WORKERS} ...")
    done = 0

    def run(job):
        nonlocal done
        path = fetch_request(*job[:6], tmp, job[6])
        done += 1
        if done % 10 == 0 or done == len(jobs):
            print(f"      {label}: {done}/{len(jobs)} fetched")
        return path

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        paths = list(ex.map(run, jobs))

    arrays = [rioxarray.open_rasterio(p) for p in paths]
    merged = merge_arrays(arrays).load()
    for a in arrays:
        a.close()
    return merged


def write_cog(da, path):
    """Write `da` as a JPEG COG, dropping quality until it lands under the limit.

    Returns (size_bytes, quality_label).
    """
    base = dict(driver="COG", dtype="uint8", blocksize=512,
                overview_resampling="average", num_threads="all_cpus",
                BIGTIFF="IF_SAFER")
    for q in QUALITY_LADDER:
        da.rio.to_raster(path, compress="JPEG", quality=q, **base)
        size = os.path.getsize(path)
        if size < SIZE_LIMIT_MB * 1e6:
            return size, f"q{q}"
    sys.exit(f"  {os.path.basename(path)} still >= {SIZE_LIMIT_MB} MB at "
             f"q{QUALITY_LADDER[-1]}; lower NAIP_TILE_MPX or raise NAIP_MPP")


def grid_shape(cols, rows, budget_px):
    """Smallest near-square tile grid keeping each tile under `budget_px`."""
    nx = ny = 1
    while (cols / nx) * (rows / ny) > budget_px:
        if cols / nx >= rows / ny:
            nx += 1
        else:
            ny += 1
    return nx, ny


def edges(total, n):
    """Pixel boundaries splitting `total` px into `n` near-equal spans."""
    return [round(k * total / n) for k in range(n + 1)]


def main():
    b = load_bbox()
    mpp = float(os.environ.get("NAIP_MPP", "1.25"))   # EPSG:3857 meters/pixel
    budget_mpx = float(os.environ.get("NAIP_TILE_MPX", "240"))
    if mpp <= 0 or budget_mpx <= 0:
        sys.exit("NAIP_MPP and NAIP_TILE_MPX must be positive")

    # Project the 4326 bbox to the 3857 extent we actually sample on.
    xmin, ymin, xmax, ymax = transform_bounds(
        "EPSG:4326", "EPSG:3857", b["west"], b["south"], b["east"], b["north"])
    cols = round((xmax - xmin) / mpp)
    rows = round((ymax - ymin) / mpp)
    nx, ny = grid_shape(cols, rows, budget_mpx * 1e6)
    cx, ry = edges(cols, nx), edges(rows, ny)

    print(f"NAIP - bbox {b['west']},{b['south']} : {b['east']},{b['north']} "
          f"@ {mpp:g} m/px (EPSG:3857)")
    print(f"  full {cols}x{rows} px ({cols * rows / 1e6:.0f} Mpx) "
          f"-> {nx}x{ny} = {nx * ny} COG tiles")

    out_dir = os.path.join(PUBLIC, OUT_DIR)
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir, exist_ok=True)
    # The high-res grid replaces any legacy single-file overlay.
    legacy = os.path.join(PUBLIC, "naip.tif")
    if os.path.exists(legacy):
        os.remove(legacy)

    manifest, total_mb = [], 0.0
    n = 0
    for j in range(ny):
        for i in range(nx):
            tcols, trows = cx[i + 1] - cx[i], ry[j + 1] - ry[j]
            tx0 = xmin + cx[i] * mpp
            ty1 = ymax - ry[j] * mpp        # north edge of this tile
            tx1, ty0 = tx0 + tcols * mpp, ty1 - trows * mpp
            n += 1
            label = f"tile {n}/{nx * ny}"
            print(f"  {label} ({tcols}x{trows} px) ...")
            with tempfile.TemporaryDirectory(prefix="naip-") as tmp:
                da = fetch_region(tx0, ty0, tx1, ty1, tcols, trows, mpp, tmp, label)
                name = f"naip_{j}_{i}.tif"
                size, q = write_cog(da, os.path.join(out_dir, name))
            mb = size / 1e6
            total_mb += mb
            manifest.append(f"{OUT_DIR}/{name}")
            print(f"    {name}: {tcols}x{trows} px, {q}, {mb:.1f} MB")

    with open(os.path.join(out_dir, MANIFEST), "w") as f:
        json.dump({"tiles": manifest, "crs": "EPSG:3857", "mpp": mpp}, f, indent=2)

    biggest = max(
        os.path.getsize(os.path.join(out_dir, os.path.basename(p)))
        for p in manifest) / 1e6
    print(f"  {len(manifest)} tiles, {total_mb:.0f} MB total, "
          f"largest {biggest:.1f} MB, manifest -> {OUT_DIR}/{MANIFEST}")
    if biggest >= SIZE_LIMIT_MB:
        sys.exit(f"  ERROR: a tile is {biggest:.1f} MB (>= {SIZE_LIMIT_MB} MB)")
    print(f"  OK: every tile under {SIZE_LIMIT_MB} MB GitHub limit")


if __name__ == "__main__":
    main()
