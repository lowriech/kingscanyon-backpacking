#!/usr/bin/env python3
"""Bake the GeoParquet intermediates in data/ into client GeoJSON in public/.

This is the final step of the data pipeline: the browser only ever loads the
GeoJSON written here. Trails come from the elevation-annotated 3D parquet
(`bake_trails_prep.py`); everything else is a straight format conversion of the
ingest layer (`bake_trails.py` / `bake_topo.py`).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from overture_common import parquet_to_geojson  # noqa: E402

# (parquet in data/, geojson out in public/)
LAYERS = [
    ("trails-3d.parquet", "trails.geojson"),
    ("topo-points.parquet", "topo-points.geojson"),
    ("lakes.parquet", "lakes.geojson"),
    ("lakes-points.parquet", "lakes-points.geojson"),
    ("rivers.parquet", "rivers.geojson"),
]


def main():
    print("Baking GeoJSON from data/*.parquet")
    for in_name, out_name in LAYERS:
        parquet_to_geojson(in_name, out_name)


if __name__ == "__main__":
    main()
