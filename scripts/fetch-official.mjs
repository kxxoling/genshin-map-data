#!/usr/bin/env node
// Snapshot pipeline for the official Genshin Impact web map.
// Pulls the public anonymous API used by act.mihoyo.com's interactive map
// (v3 map/info + v2 label/tree + v3 map/point/list) and mirrors label icons
// and base-map tiles into data/teyvat/, so the consumer app has zero runtime
// dependency on miHoYo CDNs.
//
// Failure policy: fail fast and loud. A run with failed downloads must not
// update meta.json, or the holes would go unnoticed until the next run.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = resolve(ROOT, 'data/teyvat')
const META_PATH = resolve(DATA_DIR, 'meta.json')
const POINTS_PATH = resolve(DATA_DIR, 'points.json')

// Sanity floors: never overwrite a healthy snapshot with a suspicious pull.
const MIN_POINTS = 1000
const MIN_POINTS_RATIO = 0.9

const API = 'https://waf-api-takumi.mihoyo.com/common/map_user/ys_obc'
const PARAMS = 'map_id=2&app_sn=ys_obc&lang=zh-cn'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://act.mihoyo.com/',
}

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

// Liveness watchdog: if no icon/tile request completes for 10 minutes, the
// run aborts instead of grinding until the CI job timeout (per-request
// AbortSignal.timeout bounds each fetch; this is the backstop).
const WATCHDOG_MS = 10 * 60_000
let lastProgressAt = Date.now()
const watchdog = setInterval(() => {
  if (Date.now() - lastProgressAt > WATCHDOG_MS) {
    fail(`No request completed for ${WATCHDOG_MS / 60_000} minutes - pipeline stalled, aborting`)
  }
}, 30_000)
watchdog.unref()
function markProgress() {
  lastProgressAt = Date.now()
}

async function fetchWithRetry(url, tries = 3, timeoutMs = 30_000) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      // Hard per-request timeout: a stalled socket to the CDN must fail into
      // the retry path instead of hanging the worker forever.
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    } catch (e) {
      lastErr = e
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
    }
  }
  throw lastErr
}

async function getJson(path) {
  const json = await (await fetchWithRetry(`${API}/${path}?${PARAMS}`)).json()
  if (json.retcode !== 0) throw new Error(`${path} retcode=${json.retcode} ${json.message}`)
  return json.data
}

async function getBuffer(url) {
  return Buffer.from(await (await fetchWithRetry(url)).arrayBuffer())
}

// Guard against CDN error pages being saved as .webp
function isWebp(buf) {
  return (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  )
}

// Best-effort current game version ("X.Y.Z") from the public HoYoPlay
// launcher API - the map API itself carries no version semantics, only the
// map_version hash. Reads getGameBranches' live branch tag (getGamePackages'
// main.major.version can lag behind the live version). Returns null on any
// failure; the pipeline continues without version-aware behavior then.
async function probeGameVersion() {
  try {
    const json = await (
      await fetchWithRetry(
        'https://hyp-api.mihoyo.com/hyp/hyp-connect/api/getGameBranches?launcher_id=jGHBHlcOq1&game_id=1Z8W5NHUQb&language=zh-cn',
      )
    ).json()
    if (json.retcode !== 0) throw new Error(`retcode=${json.retcode}`)
    // The response may contain branches for several games - filter by biz.
    const branch = json.data.game_branches.find((b) => b.game?.biz === 'hk4e_cn')
    const v = branch?.main?.tag
    if (!/^\d+\.\d+\.\d+$/.test(v ?? '')) throw new Error(`unexpected version format: ${v}`)
    return v
  } catch (e) {
    console.warn(`Game version probe failed (continuing without it): ${e.message}`)
    return null
  }
}

// --- Probes --------------------------------------------------------------------
// Every run probes map/info and the game version (two cheap requests), then
// refreshes the data. Refreshes are cheap by design - icons are reused when
// their URL-derived file exists and tiles are skipped entirely unless
// map_version changed - and every artifact (including meta.json and its
// fetchedAt) is only written when its content actually changed, so a
// no-change run leaves the repo byte-identical.
// GAME_VERSION overrides the probed game version for when the launcher API
// lags behind the live version; an empty string counts as unset
// (workflow_dispatch passes '' for omitted inputs).
const envOverride = process.env.GAME_VERSION?.trim() || null
if (envOverride && !/^\d+\.\d+\.\d+$/.test(envOverride)) {
  fail(`GAME_VERSION must be full semver (X.Y.Z), got: ${envOverride}`)
}
function isLowerVersion(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false
  return pa[0] !== pb[0] ? pa[0] < pb[0] : pa[1] !== pb[1] ? pa[1] < pb[1] : pa[2] < pb[2]
}
const prevMeta = existsSync(META_PATH) ? JSON.parse(readFileSync(META_PATH, 'utf8')) : null
const probed = envOverride ?? (await probeGameVersion())
// Effective version: explicit override > probe > previously recorded. A probe
// lower than the recorded version is launcher-API lag and gets ignored, so a
// lagging API can never roll the recorded version back or fire a bogus
// version-change release.
let gameVersion = probed ?? prevMeta?.gameVersion ?? null
if (
  gameVersion != null &&
  prevMeta?.gameVersion &&
  isLowerVersion(gameVersion, prevMeta.gameVersion)
) {
  console.warn(
    `Probed game version ${gameVersion} is lower than the recorded ${prevMeta.gameVersion} - launcher API lagging? Keeping ${prevMeta.gameVersion}.`,
  )
  gameVersion = prevMeta.gameVersion
}
const probe = (await getJson('v3/map/info')).info
const v2 = probe.detail_v2
if (!v2?.map_version) fail('map/info is missing detail_v2.map_version - API shape changed?')

if (prevMeta && gameVersion !== prevMeta.gameVersion) {
  console.log(`Game version changed: ${prevMeta.gameVersion ?? 'unknown'} -> ${gameVersion}`)
}
if (prevMeta && prevMeta.mapVersion !== v2.map_version) {
  console.log(`map_version changed: ${prevMeta.mapVersion} -> ${v2.map_version}`)
}

const tree = (await getJson('v2/map/label/tree')).tree
const points = (await getJson('v3/map/point/list')).point_list

// --- Sanity checks --------------------------------------------------------------
if (!tree?.length) fail('label/tree returned an empty tree - aborting')
if (points.length < MIN_POINTS) {
  fail(`point/list returned only ${points.length} points (< ${MIN_POINTS}) - aborting`)
}
let prevPointsCount = null
if (existsSync(POINTS_PATH)) {
  prevPointsCount = JSON.parse(readFileSync(POINTS_PATH, 'utf8')).length
  if (points.length < prevPointsCount * MIN_POINTS_RATIO) {
    fail(`Point count dropped sharply: ${prevPointsCount} -> ${points.length} - aborting`)
  }
}

mkdirSync(DATA_DIR, { recursive: true })

// --- Icon snapshot ----------------------------------------------------------------
// Download every label icon locally (the act-upload host has no CORS, so
// browsers cannot fetch it directly). Snapshotting also pins versions: the
// consumer app ends up with zero runtime image dependencies. Concurrency is
// limited to stay polite to the CDN.
const ICON_DIR = resolve(DATA_DIR, 'icons')
mkdirSync(ICON_DIR, { recursive: true })

function collectIcons(nodes, out = []) {
  for (const n of nodes) {
    if (n.icon) out.push(n.icon)
    if (n.children) collectIcons(n.children, out)
  }
  return out
}

function iconFilename(url) {
  return `${new URL(url).pathname.replaceAll('/', '_').slice(-60)}.webp`
}

const iconUrls = [...new Set(collectIcons(tree))]
// Filenames derive from the URL tail; surface the (theoretical) collision
// instead of silently overwriting one icon with another.
const fileOwner = new Map()
for (const url of iconUrls) {
  const file = iconFilename(url)
  if (fileOwner.has(file) && fileOwner.get(file) !== url) {
    fail(`Icon filename collision on ${file} - aborting`)
  }
  fileOwner.set(file, url)
}

const localByIcon = new Map()
let iconDone = 0
let iconsDownloaded = 0
const iconQueue = [...iconUrls]
async function iconWorker() {
  for (;;) {
    const url = iconQueue.shift()
    if (!url) return
    // Snapshot filenames derive from the URL and committed files were
    // webp-validated on write - reuse an existing file instead of
    // re-downloading it (same-version refreshes cost zero image requests).
    const file = iconFilename(url)
    if (existsSync(resolve(ICON_DIR, file))) {
      localByIcon.set(url, `icons/${file}`)
      iconDone++
      markProgress()
      continue
    }
    // OSS image processing params: 64px webp (originals can be hundreds of KB).
    // searchParams.set() keeps the URL valid even if it already carries a query.
    const u = new URL(url)
    u.searchParams.set('x-oss-process', 'image/resize,w_64/quality,Q_90/format,webp')
    const buf = await getBuffer(u)
    if (!isWebp(buf)) fail(`Icon response is not webp: ${url}`)
    writeFileSync(resolve(ICON_DIR, file), buf)
    localByIcon.set(url, `icons/${file}`)
    iconsDownloaded++
    iconDone++
    markProgress()
    if (iconDone % 100 === 0) console.log(`icons: ${iconDone}/${iconUrls.length}`)
  }
}
try {
  await Promise.all(Array.from({ length: 6 }, iconWorker))
} catch (e) {
  // No remote-URL fallback here on purpose: the host has no CORS, so a remote
  // reference would be broken in the browser anyway. Fail and retry next run.
  fail(`Icon download failed after retries: ${e.message} - aborting`)
}
console.log(`icons: ${localByIcon.size}/${iconUrls.length} present (${iconsDownloaded} downloaded)`)

// --- Tile snapshot -------------------------------------------------------------------
// Download the full zoom pyramid. Tiles are stored by grid position and
// content-hashed: a tile identical to the local copy is not rewritten, so a
// version update only records the tiles that actually changed (each map
// version touches a small part of the canvas).
const TILES_DIR = resolve(DATA_DIR, 'tiles')
mkdirSync(TILES_DIR, { recursive: true })
const tileJobs = []
for (let z = v2.min_zoom; z <= v2.max_zoom; z++) {
  // total_size is a multiple of 256; Math.floor would silently drop edge
  // tiles otherwise.
  const cols = Math.floor((v2.total_size[0] * 2 ** z) / 256)
  const rows = Math.floor((v2.total_size[1] * 2 ** z) / 256)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      tileJobs.push({ x, y, z, suffix: `${z < 0 ? 'N' : 'P'}${Math.abs(z)}` })
    }
  }
}
// Tiles only change together with map_version (the version hash covers the
// whole tile set and is embedded in every tile URL). Same-version refreshes
// skip the 13,770-tile download entirely - after checking the local set is
// complete, so a damaged checkout still repairs itself with a full pass.
const localTileCount = existsSync(TILES_DIR) ? readdirSync(TILES_DIR).length : 0
const tilesNeeded =
  !prevMeta || prevMeta.mapVersion !== v2.map_version || localTileCount !== tileJobs.length
let tileDone = 0
let tileKept = 0
let tileWritten = 0
let tileBytes = 0
let tileFailed = 0
if (!tilesNeeded) {
  console.log(
    `tiles: map_version unchanged and set complete (${localTileCount} files) - skipping refresh`,
  )
  tileKept = localTileCount
} else {
  console.log(`tiles: ${tileJobs.length} queued`)
  const tileCdnBase = `https://act-webstatic.mihoyo.com/ys-map-op/map/${probe.id}/${v2.map_version}`
  let tileIdx = 0
  async function tileWorker() {
    for (;;) {
      const job = tileJobs[tileIdx++]
      if (!job) return
      const name = `${job.x}_${job.y}_${job.suffix}.webp`
      const localPath = resolve(TILES_DIR, name)
      try {
        const buf = await getBuffer(`${tileCdnBase}/${name}`)
        if (!isWebp(buf)) throw new Error('response is not webp')
        const hash = createHash('sha256').update(buf).digest('hex')
        if (existsSync(localPath)) {
          const localHash = createHash('sha256').update(readFileSync(localPath)).digest('hex')
        if (localHash === hash) {
          tileKept++
          markProgress()
          continue
        }
        }
        writeFileSync(localPath, buf)
        tileWritten++
        tileBytes += buf.length
      } catch (e) {
        tileFailed++
        console.error(`tile failed ${name}: ${e.message}`)
      }
      tileDone++
      markProgress()
      if (tileDone % 2000 === 0) console.log(`tiles: ${tileDone}/${tileJobs.length}`)
    }
  }
  await Promise.all(Array.from({ length: 8 }, tileWorker))
  console.log(
    `tiles: ${tileKept} unchanged / ${tileWritten} updated (${(tileBytes / 1048576).toFixed(1)}MB written) / ${tileFailed} failed`,
  )
  if (tileFailed > 0) {
    fail(`${tileFailed} tiles failed to download - aborting without refreshing meta.json`)
  }
}

// --- JSON artifacts -----------------------------------------------------------------
// Write an artifact only when its content actually changed.
function writeIfChanged(path, content) {
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (prev === content) return false
  writeFileSync(path, content)
  return true
}

// Label tree: keep id/name/icon (pointing at the local snapshot)/children only.
function slimLabel(node) {
  const out = { id: node.id, name: node.name, icon: localByIcon.get(node.icon) ?? node.icon }
  if (node.children?.length) out.children = node.children.map(slimLabel)
  return out
}
// Pretty-printed like meta.json: the tree is small and changes land as
// readable line-level diffs.
const labelsChanged = writeIfChanged(
  resolve(DATA_DIR, 'labels.json'),
  `${JSON.stringify(tree.map(slimLabel), null, 2)}\n`,
)

// Points: slim fields, coordinates rounded to 2 decimals. Sorted by id so git
// diffs and delta compression stay stable regardless of API ordering.
const slimPoints = points
  .map((p) => {
    const out = {
      id: p.id,
      labelId: p.label_id,
      x: Math.round(p.x_pos * 100) / 100,
      y: Math.round(p.y_pos * 100) / 100,
    }
    if (p.z_level) out.z = p.z_level
    return out
  })
  .sort((a, b) => a.id - b.id)
// One record per line: the file stays a standard JSON array (consumers keep
// plain JSON.parse) at ~2% size overhead, while git diffs stay entry-level
// instead of rewriting a single 4MB line on every snapshot.
const pointsChanged = writeIfChanged(
  POINTS_PATH,
  `[\n${slimPoints.map((p) => JSON.stringify(p)).join(',\n')}\n]\n`,
)

// Meta is written last and only when something actually changed, with
// fetchedAt excluded from the comparison so a timestamp alone never produces
// a commit. Paths inside the snapshot are relative to the snapshot root;
// consumers join them with their own mount base (see README).
const meta = {
  mapId: probe.id,
  mapVersion: v2.map_version,
  // Current game version per the HoYoPlay launcher; omitted when the probe
  // failed - the next successful run fills it in.
  ...(gameVersion ? { gameVersion } : {}),
  origin: v2.origin,
  totalSize: v2.total_size,
  minZoom: v2.min_zoom,
  maxZoom: v2.max_zoom,
  tileUrlTemplate: 'tiles/{x}_{y}_{suffix}.webp',
  cdnTileUrlTemplate:
    'https://act-webstatic.mihoyo.com/ys-map-op/map/{mapId}/{mapVersion}/{x}_{y}_{suffix}.webp',
  fetchedAt: new Date().toISOString(),
}
const stripTimestamp = (m) => {
  const { fetchedAt, ...rest } = m ?? {}
  return rest
}
const metaChanged = JSON.stringify(stripTimestamp(meta)) !== JSON.stringify(stripTimestamp(prevMeta))
const dataChanged = iconsDownloaded > 0 || tileWritten > 0 || labelsChanged || pointsChanged
if (dataChanged || metaChanged) {
  writeFileSync(META_PATH, `${JSON.stringify(meta, null, 2)}\n`)
} else {
  console.log('no changes - snapshot and meta.json left untouched')
}

// Run summary for the release workflow (scripts/cut-release.sh): tag decision
// inputs and changelog numbers. Written at the repo root on success only;
// deliberately outside data/ so it is never committed.
const summary = {
  timestamp: meta.fetchedAt,
  gameVersion,
  prevGameVersion: prevMeta?.gameVersion ?? null,
  mapVersion: meta.mapVersion,
  prevMapVersion: prevMeta?.mapVersion ?? null,
  points: slimPoints.length,
  prevPoints: prevPointsCount,
  topLevelLabels: tree.length,
  tilesQueued: tileJobs.length,
  tilesWritten: tileWritten,
  tilesKept: tileKept,
  tilesFailed: tileFailed,
  icons: localByIcon.size,
}
writeFileSync(resolve(ROOT, 'snapshot-summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

clearInterval(watchdog)
console.log(
  `snapshot complete: game_version=${gameVersion ?? 'unknown'} map_version=${meta.mapVersion} points=${slimPoints.length} top-level labels=${tree.length} changes=${dataChanged || metaChanged ? 'yes' : 'none'}`,
)
