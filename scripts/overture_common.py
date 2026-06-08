"""Shared helpers for the Overture data-fetch scripts.

The project bounding box lives in scripts/bbox.json (single source of truth).
When it changes, re-run `make data` to refetch every map data source.
"""
import json
import os

import duckdb

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
PUBLIC = os.path.join(REPO, "public")
# Intermediate GeoParquet (the ingest + prep layer). The client only ever sees
# the GeoJSON baked into PUBLIC; everything under DATA is a build artifact.
DATA = os.path.join(REPO, "data")

# Overture release to pull from (override with OVERTURE_RELEASE env var).
RELEASE = os.environ.get("OVERTURE_RELEASE", "2026-05-20.0")


def load_bbox():
    with open(os.path.join(HERE, "bbox.json")) as f:
        return json.load(f)


def bbox_sql(b):
    """Predicate-pushdown filter on Overture's `bbox` struct column."""
    return (f"bbox.xmin BETWEEN {b['west']} AND {b['east']} "
            f"AND bbox.ymin BETWEEN {b['south']} AND {b['north']}")


def connect():
    ext_dir = os.environ.get("DUCKDB_EXT_DIR", os.path.join(REPO, ".duckdb"))
    os.makedirs(ext_dir, exist_ok=True)
    con = duckdb.connect(config={"extension_directory": ext_dir})
    con.execute(
        "INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; "
        "SET s3_region='us-west-2';"
    )
    return con


def source(theme, type_):
    return (f"read_parquet('s3://overturemaps-us-west-2/release/{RELEASE}/"
            f"theme={theme}/type={type_}/*', hive_partitioning=1)")


def to_geoparquet(con, sql, out):
    """Run a spatial query and write the result to data/<out> as GeoParquet.

    `sql` must expose a GEOMETRY column named `geometry`; every other selected
    column is carried through as a feature property. The geometry is handed off
    to GeoPandas via WKB so the file is a standard GeoParquet that
    `geopandas.read_parquet` (the prep + bake steps) reads natively.
    """
    import geopandas as gpd

    os.makedirs(DATA, exist_ok=True)
    df = con.execute(
        f"SELECT * EXCLUDE (geometry), ST_AsWKB(geometry) AS geometry "
        f"FROM ({sql}) t WHERE t.geometry IS NOT NULL"
    ).fetch_df()
    # DuckDB hands WKB back as bytearray; shapely.from_wkb wants bytes.
    wkb = df["geometry"].map(lambda b: bytes(b) if b is not None else None)
    gdf = gpd.GeoDataFrame(
        df.drop(columns="geometry"),
        geometry=gpd.GeoSeries.from_wkb(wkb),
        crs="EPSG:4326",
    )
    path = os.path.join(DATA, out)
    gdf.to_parquet(path)
    kb = round(os.path.getsize(path) / 1024, 1)
    print(f"  {out}: {len(gdf)} features, {kb} KB")
    return len(gdf)


def parquet_to_geojson(in_name, out_name):
    """Convert a GeoParquet file in data/ to client-facing GeoJSON in public/."""
    import geopandas as gpd

    os.makedirs(PUBLIC, exist_ok=True)
    gdf = gpd.read_parquet(os.path.join(DATA, in_name))
    path = os.path.join(PUBLIC, out_name)
    gdf.to_file(path, driver="GeoJSON")
    n = len(json.load(open(path))["features"])
    kb = round(os.path.getsize(path) / 1024, 1)
    print(f"  {out_name}: {n} features, {kb} KB")
    return n
