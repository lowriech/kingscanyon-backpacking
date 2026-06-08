PORT := 5173
LOG := dev-server.log

# All Python data work runs through uv (deps declared in pyproject.toml).
UV := uv

.PHONY: start stop restart install logs kill-port data data-trails data-topo data-dem data-naip data-trails-prep data-bake

## start: install deps, free port 5173, run the Vite dev server in the background
start: kill-port node_modules
	@echo "Starting dev server on http://127.0.0.1:$(PORT) ..."
	@nohup bun run dev > $(LOG) 2>&1 &
	@sleep 1
	@echo "Dev server started (logs: make logs)"

## stop: kill whatever is running on port 5173
stop: kill-port
	@echo "Dev server stopped"

## restart: stop then start
restart: stop start

## logs: tail the dev server log
logs:
	@touch $(LOG)
	@tail -f $(LOG)

## install: install dependencies with bun
install:
	@bun install

# Install deps only if they are missing
node_modules:
	@bun install

# Free port 5173 by killing any process bound to it
kill-port:
	@lsof -ti tcp:$(PORT) | xargs kill -9 2>/dev/null && echo "Freed port $(PORT)" || echo "Port $(PORT) already free"

## data: ingest -> prep -> bake the full pipeline for the project bbox and regenerate summaries
##       (assumes public/dem.tif already exists; run `make data-dem` when the bbox changes)
data: data-trails data-topo data-trails-prep data-bake
	@$(UV) run python scripts/write_summaries.py

## data-trails: ingest Overture trails into data/trails.parquet (GeoParquet)
data-trails:
	@$(UV) run python scripts/bake_trails.py

## data-topo: ingest peaks/passes/lakes/rivers into data/*.parquet (GeoParquet)
data-topo:
	@$(UV) run python scripts/bake_topo.py

## data-dem: fetch the elevation GeoTIFF (USGS 3DEP) into public/dem.tif
data-dem:
	@$(UV) run python scripts/bake_dem.py

## data-naip: fetch NAIP aerial imagery (USGS / The National Map) into a grid of
##            <100MB COG tiles under public/naip/ (slow; override sampling with
##            NAIP_MPP=<3857 m/px, default 1.25> and NAIP_TILE_MPX=<Mpx/tile>)
data-naip:
	@$(UV) run python scripts/bake_naip.py

## data-trails-prep: split @1km + LineString Z + DEM elevation -> data/trails-3d.parquet
data-trails-prep:
	@$(UV) run python scripts/bake_trails_prep.py

## data-bake: convert the data/*.parquet intermediates into client public/*.geojson
data-bake:
	@$(UV) run python scripts/bake_geojson.py
