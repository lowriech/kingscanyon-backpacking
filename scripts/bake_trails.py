#!/usr/bin/env python3
"""Ingest named trails (Overture transportation segments) into data/trails.parquet.

Trail-class line features (path/footway/track/steps/bridleway/pedestrian) with a
name, clipped to the project bounding box (scripts/bbox.json), written as
GeoParquet. The elevation-annotated client GeoJSON is produced downstream by
`bake_trails_prep.py` (split + LineStringZ) and `bake_geojson.py`.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from overture_common import bbox_sql, connect, load_bbox, source, to_geoparquet  # noqa: E402

TRAIL_CLASSES = ("path", "footway", "track", "steps", "bridleway", "pedestrian")


def main():
    b = load_bbox()
    con = connect()
    classes = ", ".join(f"'{c}'" for c in TRAIL_CLASSES)
    print(f"Trails — bbox {b['west']},{b['south']} : {b['east']},{b['north']}")
    to_geoparquet(con, f"""
      SELECT names.primary AS name, class, id, geometry
      FROM {source('transportation', 'segment')}
      WHERE {bbox_sql(b)} AND subtype='road'
        AND class IN ({classes})
        AND names.primary IS NOT NULL
    """, "trails.parquet")


if __name__ == "__main__":
    main()
