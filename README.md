# genshin-map-data

Snapshot of the official Genshin Impact web map, consumed by
[genshin-pix-map](https://github.com/kxxoling/genshin-pix-map) as a git
submodule.

## Contents

- `data/teyvat/meta.json` — map metadata (versions, origin, canvas size, tile URL template)
- `data/teyvat/labels.json` — label tree
- `data/teyvat/points.json` — all points, sorted by id, one record per line
- `data/teyvat/icons/` — marker icons (64px webp)
- `data/teyvat/tiles/` — base-map tiles, full zoom pyramid (~73MB)

Paths inside the snapshot are relative to `data/teyvat/`; consumers join them
with their own mount base.

## Releases

One release per game version, plus patch releases for data-only updates.
Every release attaches `teyvat-full-<tag>.tar.gz` (complete snapshot) and,
when a previous release exists, `teyvat-diff-<prev>-<tag>.tar.gz` (changed
files plus a `DELETED.txt` manifest).

## Automation

GitHub Actions checks weekly (Monday 08:00 UTC) and commits only when the
snapshot actually changed; manual runs behave identically and accept an
optional `game_version` override. Real changes also notify the consumer repo
via `repository_dispatch` — prerequisites in this repo's Settings:

- Variables → `CONSUMER_REPO` (e.g. `kxxoling/genshin-pix-map`)
- Secrets → `DISPATCH_TOKEN` (PAT with `contents:read` + `actions:write`)

Local run: `node scripts/fetch-official.mjs` (optional `GAME_VERSION=<version>`
override).

## Credits

Data comes from the public anonymous endpoints used by act.mihoyo.com's
interactive map. Genshin Impact and all related assets are copyrighted by
miHoYo / HoYoverse; this repo collects only factual data (coordinates, names)
for open-source community tools and is not affiliated with miHoYo.
