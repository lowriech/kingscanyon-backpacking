#!/usr/bin/env python3
"""Ingest topographic features (Overture base theme) into data/*.parquet.

Outputs (GeoParquet, converted to client GeoJSON later by `bake_geojson.py`):
  topo-points.parquet  peaks + passes (points, with elevation)
  lakes.parquet        lakes (polygons)
  lakes-points.parquet lake center points carrying the name (for labels)
  rivers.parquet       rivers (lines)

All clipped to the project bounding box (scripts/bbox.json).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from overture_common import bbox_sql, connect, load_bbox, source, to_geoparquet  # noqa: E402


def main():
    b = load_bbox()
    con = connect()
    where = bbox_sql(b)
    print(f"Topo — bbox {b['west']},{b['south']} : {b['east']},{b['north']}")

    # Peaks + passes as labeled points with elevation
    to_geoparquet(con, f"""
      SELECT names.primary AS name, 'peak' AS kind, elevation, geometry
        FROM {source('base', 'land')}
        WHERE {where} AND subtype='physical' AND class='peak'
          AND names.primary IS NOT NULL
      UNION ALL BY NAME
      SELECT names.primary AS name, 'pass' AS kind, elevation, geometry
        FROM {source('base', 'land')}
        WHERE {where} AND subtype='physical' AND class='saddle'
          AND names.primary IS NOT NULL
    """, "topo-points.parquet")

    # Lakes as polygons
    to_geoparquet(con, f"""
      SELECT names.primary AS name, geometry FROM {source('base', 'water')}
        WHERE {where} AND subtype='lake' AND names.primary IS NOT NULL
    """, "lakes.parquet")

    # Lake center points carrying the name (point guaranteed inside the polygon)
    to_geoparquet(con, f"""
      SELECT names.primary AS name,
             ST_PointOnSurface(geometry) AS geometry
        FROM {source('base', 'water')}
        WHERE {where} AND subtype='lake' AND names.primary IS NOT NULL
    """, "lakes-points.parquet")

    # Rivers as lines
    to_geoparquet(con, f"""
      SELECT names.primary AS name, geometry FROM {source('base', 'water')}
        WHERE {where} AND subtype='river' AND names.primary IS NOT NULL
    """, "rivers.parquet")


if __name__ == "__main__":
    main()
