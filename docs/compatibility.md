# npm_lazy compatibility assessment

This document records what `npm_lazy` actually does when current npm clients use
it as a registry cache, and it states one disposition for this image.

Everything below is produced by the harness in `test/compatibility/`. Nothing
here is inferred from upstream documentation or release notes.

## Running the assessment

```sh
npm run test:compatibility
```

Equivalently, `node test/compatibility/run.js`. The harness:

- installs `npm_lazy` into `test/compatibility/.work/sandbox` (a throwaway
  sandbox, already ignored by `.gitignore`) — the repository's own
  `package.json` dependencies and `Dockerfile` are never touched;
- starts the server with `process.execPath`, so the Node line under test is
  whichever Node runs the harness;
- drives real `npm install` / `npm view` runs and raw HTTP probes through it;
- writes a machine-readable result set to `test/compatibility/.work/results.json`
  and prints the matrix below.

It exits non-zero only on unexpected failures. Reproduced known defects are
reported as `XFAIL` and do not fail the run.

Useful switches:

| Variable / flag | Effect |
| --- | --- |
| `--node-matrix` | also probe `npm_lazy` on a range of Node versions in Docker (slow) |
| `COMPAT_SKIP_DOCKER=1` | skip every Docker-backed scenario |
| `COMPAT_NPM_LAZY_VERSION` | version under test (default `1.14.0`) |
| `COMPAT_CLIENT_IMAGES` | npm client images (default `node:20-alpine,node:22-alpine,node:24-alpine`) |
| `COMPAT_NODE_IMAGES` | images for the Node floor matrix |
| `COMPAT_REGISTRY` | upstream registry (default `https://registry.npmjs.org/`) |
| `COMPAT_WORK_DIR` | sandbox location |

The harness needs outbound access to the upstream registry and, for the Docker
scenarios, a working Docker daemon with host networking. It never publishes an
image and never writes outside its work directory, so it is safe to run in CI
as-is.

## Versions tested

| Component | Version |
| --- | --- |
| `npm_lazy` | 1.14.0 (published 2017-01-05, latest release) |
| Node running `npm_lazy` | v24.14.0 (Node 24 LTS) |
| Host npm client | 12.0.1 |
| Docker npm clients | `node:20-alpine` (node v20.20.2, npm 10.8.2), `node:22-alpine` (node v22.23.1, npm 10.9.8), `node:24-alpine` (node v24.18.0, npm 11.16.0) |
| Upstream registry | `https://registry.npmjs.org/` |
| Platform | Linux x86_64 |
| Assessment date | 2026-07-26 |

Fixtures: `process@0.11.10` (unscoped), `@sindresorhus/is@8.1.0` (scoped),
`once@1.4.0` (pulls `wrappy@1.0.2`, so installs exercise transitive
resolution), `express` (large packument, metadata size only).

## Compatibility matrix

`PASS` = scenario asserted and met. `XFAIL` = defect reproduced deliberately;
the detail column is the evidence.

| ID | Scenario | Result | Detail |
| --- | --- | --- | --- |
| C01 | Install `npm_lazy@1.14.0` on Node 24 | PASS | installs cleanly; 9 deprecation warnings, 122 transitive dependencies |
| C02 | Unscoped metadata, cold cache | PASS | `GET /process` → 200, 31,176 bytes, 21 versions |
| C03 | Scoped metadata, cold cache | PASS | `GET /@sindresorhus%2fis` → 200, 201,932 bytes, 63 versions |
| C04 | `external-url` rewriting | PASS | every `versions[*].dist.tarball` rewritten; no upstream host left in served metadata |
| C05 | Unscoped tarball, cold cache | PASS | 4,669 bytes, sha1 `7332300e840161bda3e69a1d1d91a7d4bc16f182` matches the registry `shasum` |
| C06 | Scoped tarball, cold cache | PASS | 23,407 bytes, sha1 `00d7b9dc92664550fe933cdcfaa8665bc4111202` matches the registry `shasum` |
| C07 | Upstream TLS to registry.npmjs.org | PASS | all upstream fetches are `https://` with `rejectUnauthorized=true` |
| C08 | `npm install`, cold proxy + cold client cache | PASS | 4 packages installed, 2 tarballs pulled upstream |
| C09 | `npm install`, warm proxy + cold client cache | PASS | 0 tarballs refetched upstream; metadata revalidated (expected at `cacheAge=0`) |
| C10 | `npm view`, unscoped and scoped | PASS | both resolve to the expected version |
| C11 | Abbreviated (corgi) metadata requests | PASS | served, but always as a full packument — see "Metadata amplification" |
| C12 | `/-/ping` and `/-/v1/search` | PASS | proxied uncached to upstream |
| C13 | Unencoded scoped path `/@scope/name` | XFAIL | HTTP 405 — routed as `/package/version`; the npm CLI uses the `%2f` form, so this is not fatal |
| C14 | Cache persistence across a restart | PASS | restarted server with the same cache dir served all 4 packages with 0 upstream tarball fetches |
| C15.1 | npm client `node:20-alpine` (npm 10.8.2) | PASS | full install through the proxy |
| C15.2 | npm client `node:22-alpine` (npm 10.9.8) | PASS | full install through the proxy |
| C15.3 | npm client `node:24-alpine` (npm 11.16.0) | PASS | full install through the proxy |
| C16 | Warm the cache through a local upstream stub | PASS | 4 packages cached |
| C17 | Metadata during an upstream outage | PASS | both packuments served from disk after retries are exhausted |
| C18 | Tarballs during an upstream outage | PASS | 4,669 and 23,407 bytes served from disk |
| C19 | `npm install` during an upstream outage | PASS | 4 packages installed with upstream unreachable |
| C20 | Self-signed upstream rejected by default | PASS | HTTP 500; certificate rejected |
| C21 | `rejectUnauthorized=false` accepts self-signed | PASS | served and rewritten |
| C22 | Recovery from a corrupted cached tarball | XFAIL | **the server process exits** — see "Cache-corruption crash" |

Issue #28 asked for five things specifically; all five are covered:

| Requirement | Scenarios |
| --- | --- |
| Unscoped and scoped metadata and tarballs | C02, C03, C05, C06, C08 |
| Cold and warm cache paths | C08 (cold), C09 (warm), C17–C19 (warm with upstream down) |
| Cache persistence across restarts | C14 |
| Upstream TLS | C07, C20, C21 |
| `external-url` rewriting | C04, C21 |

## Node runtime matrix

Produced by `node test/compatibility/run.js --node-matrix`, which runs an
end-to-end smoke test (install, start, unscoped metadata, scoped metadata,
`external-url` rewriting, tarball fetch, corrupted-cache recovery) inside each
image.

| Image | Node | Serving works | Corrupt-cache recovery |
| --- | --- | --- | --- |
| `node:8-alpine` | v8.17.0 | yes | yes |
| `node:10-alpine` | v10.24.1 | yes | **crashes the server** |
| `node:12-alpine` | v12.22.12 | yes | **crashes the server** |
| `node:18-alpine` | v18.20.8 | yes | **crashes the server** |
| `node:20-alpine` | v20.20.2 | yes | **crashes the server** |
| `node:22-alpine` | v22.23.1 | yes | **crashes the server** |
| `node:24-alpine` | v24.18.0 | yes | **crashes the server** |

"Serving works" means the container installed `npm_lazy@1.14.0`, started it,
and served unscoped metadata, scoped metadata, a rewritten `external-url`, and a
valid gzip tarball. "Crashes the server" means the `npm_lazy` process exited
with code 1 when asked to repair a corrupted cache entry.

Conclusions on the Node envelope for `npm_lazy@1.14.0`:

- **No ceiling for the serving paths.** Every request path required by issue #28
  works on the newest Node line tested (Node 24 LTS on the host, `node:24-alpine`
  in the matrix). The 2016-era dependency graph, including `request@2.79.0`,
  still loads and still speaks TLS to registry.npmjs.org.
- **A hard floor of Node 8 for full correctness.** The cache-corruption recovery
  path is the only behaviour that regresses with newer Node, and it regresses
  between Node 8 and Node 10 — exactly where `fs.unlink()` without a callback
  stopped being a deprecation and started throwing. Node 8 went end-of-life in
  December 2019, so there is no Node version that is both supported and correct
  on this path.

## Observed failures

### Cache-corruption crash (C22, all Node >= 10)

Corrupt one cached tarball, then request it. `npm_lazy` correctly detects the
bad checksum and tries to invalidate the entry — and the process dies:

```
app debug Cached package is corrupt. Refetching https://registry.npmjs.org/process/-/process-0.11.10.tgz
TypeError [ERR_INVALID_ARG_TYPE]: The "cb" argument must be of type function. Received undefined
    at Object.unlink (node:fs:1919:14)
    at .../npm_lazy/lib/cache.js:45:10
    at Cache.junk (.../npm_lazy/lib/cache.js:41:48)
    at .../npm_lazy/lib/resource.js:143:17
```

`Cache.junk()` calls `fs.unlink(cacheFile)` with no callback. That was a runtime
deprecation through Node 8 and has thrown since Node 10, so on every currently
supported Node the recovery path takes the whole server down instead of
refetching. The client sees a dropped connection, and the container restarts
with the same corrupt entry still on disk — the crash repeats on the next
request for that tarball. Only a fork or an upstream release can fix it.

### Metadata amplification (C11)

`npm_lazy` does not forward the client's `Accept` header upstream and does not
vary its cache on it. Every packument is fetched and stored in full, and full
packuments are what clients get back even when they asked for the abbreviated
(`application/vnd.npm.install-v1+json`) form:

| Package | Served by the proxy | Abbreviated, direct from the registry |
| --- | --- | --- |
| `express` | 803,804 bytes | 339,376 bytes (2.37x smaller) |
| `npm` | ~25 MB | ~1 MB |

The 25 MB figure is not synthetic: a single `npm install` behind the proxy made
npm's update check request `/npm`, and `npm_lazy` wrote a 25 MB full packument
into the cache directory to answer it. This is a bandwidth and disk cost, not a
correctness failure — every client tested still installed successfully.

### Unencoded scoped metadata path (C13)

`GET /@scope/name` (unencoded) is matched by the `/package/version` route, so
`npm_lazy` asks upstream for `@scope` and returns the registry's HTTP 405. The
npm CLI always uses the `%2f`-encoded form, so this does not affect npm; it does
affect anything hand-rolled against the proxy.

### Cache-key duplication (observed, not asserted)

Cache keys are the full upstream URL, verbatim and case-sensitive. A request for
`@sindresorhus%2Fis` and one for `@sindresorhus%2fis` produce two separate
202 KB cache entries for the same package. Changing `remote-url` also
invalidates the entire cache, because every key is prefixed with it.

### Dependency-tree security posture (not a runtime failure)

`npm audit` against the exact tree that `npm_lazy@1.14.0` installs:

```
14 vulnerabilities (7 moderate, 5 high, 2 critical) across 122 dependencies
critical: form-data, request
high:     boom, cryptiles, hawk, hoek, sntp
```

npm reports no forward fix for any of them. The only "fix" it can offer is
downgrading to `npm_lazy@1.5.0`. Upstream `npm_lazy` has not published since
2017-01-05, so this tree cannot be repaired from the outside.

## Not tested

These were out of scope for this assessment and are **not** claimed to work:

- private registries and authenticated upstreams (`npm_lazy` does forward an
  `Authorization` header, but no fixture exercises it);
- publishing (`npm publish`) and other write operations;
- alternative clients: yarn, pnpm, bun;
- architectures other than linux/amd64;
- the repository's Docker image itself — the harness exercises `npm_lazy` on a
  modern Node, not the `node:4.8.1-onbuild` image on `master`;
- concurrent-client behaviour and cache-eviction policy.

## Disposition

**Migrate to a maintained backend.**

The evidence does not support retiring the image: `npm_lazy@1.14.0` passes every
functional requirement in issue #28 on Node 24 with npm 10, 11 and 12 clients,
including the offline-cache behaviour that is the entire point of this image.
Users are not broken today, so there is no cause to pull the image out from
under them.

The evidence also does not support maintaining `npm_lazy`. Two findings decide
it, and neither can be fixed downstream:

1. **The single strongest piece of evidence:** `npm_lazy` reacts to a corrupted
   cache entry by crashing the server process on every supported Node
   (C22, reproduced on Node 10, 12, 18, 20, 22 and 24; correct only on Node 8,
   EOL since 2019). A cache proxy whose cache-repair path is a denial of service
   against itself cannot be recommended for the job it exists to do.
2. Its dependency tree carries 2 critical and 5 high advisories with no forward
   fix, and upstream has not published in nine years.

Fixing either one means forking `npm_lazy` and taking ownership of a 2016-era
dependency graph. That is a substantially larger commitment than this repository
— a thin Docker wrapper — has ever made.

### Recommended sequence

1. **Interim:** land the `npm_lazy@1.14.0` bump requested in #27. 1.14.0 passes
   this matrix; the currently declared `^1.10.0` has not been assessed at all.
   This is a strict improvement and buys time.
2. **Candidate:** evaluate [verdaccio](https://www.npmjs.com/package/verdaccio)
   as the replacement backend. Verified facts only: latest release 6.8.0
   published 2026-07-13, `engines.node` is `>=20`, 446 published versions. No
   claim is made here about its behaviour as a cache — it has not been run.
3. **Bounded compatibility contract:** before switching, re-run this harness
   against the candidate. Scenarios C02–C19 are plain HTTP and `npm` assertions
   against a proxy URL; only sandbox provisioning and server startup
   (`test/compatibility/lib/server.js`, `server-entry.js`) are `npm_lazy`-specific.
   The contract to meet is: scoped and unscoped metadata and tarballs, cold and
   warm cache, restart persistence, upstream TLS, external-URL rewriting, and a
   corrupted cache entry that is repaired rather than fatal.
4. **Migration path for users:** the on-disk cache formats are not compatible
   (`npm_lazy` uses a flat cache directory plus `meta.json` keyed by upstream
   URL). Migration is therefore a cold cache, not a data migration. Document
   that, keep the `npm_lazy` image published and pinned for at least one release
   after the replacement ships, and provide the equivalent
   `--port` / `--external-url` / `--cache-directory` configuration mapping so
   existing `docker run` invocations can be translated mechanically.
5. **Retirement, only after the above:** mark the `npm_lazy` image deprecated
   once the replacement has shipped and the migration note is published.
