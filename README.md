# graphiCode

A read-only code explorer you can send as **one HTML file**. Generate locally, open with a double-click, and browse without a server or internet connection.

## Quick start

Requires Node.js 22+ and npm. Git is needed only for Git comparisons. Supported viewing baseline: modern Chrome/Edge, Firefox 115+, Safari 17+; Chromium is covered by the included browser checks.

```sh
npm install
npm run build
node dist/cli.js snapshot /path/to/project --out output/project.html
node dist/cli.js diff /path/to/repo --base main --head feature --out output/review.html
node dist/cli.js diff /path/to/repo --working-tree --include-untracked --out output/local.html
```

On Windows, quote paths containing spaces. The commands work in PowerShell. `npm link` is optional if you want the `graphicode` executable globally; it is not required.

```sh
node dist/cli.js snapshot . --include "src/**" --exclude "**/*.generated.*" --dry-run
node dist/cli.js snapshot . --out output/source.html --force
npm run demo
```

`npm run demo` creates `output/demo.html` and `output/demo-diff.html`, with representative Kotlin, TypeScript, Python, Rust, CSS, and configuration files. Demo source is sample code for viewing, not an application to execute.

## What you get

- File tree with virtualized rows, fuzzy file finder, tabs, breadcrumbs, keyboard navigation.
- Read-only CodeMirror source with bundled language support and plain-text fallback.
- Worker-based full-text search, progressive results, cancellation, and a 32 MiB decoded-text cache.
- Unified and split diffs, change navigation, collapsible unchanged context, synchronized scrolling.
- Zoomable code city with districts, neighborhoods, file buildings, minimap, and changed-file overlays. This is a folder map, not a call graph.
- Light/dark themes, embedded fonts, mobile navigation, and reduced-motion support.
- File/line links: `#file=src%2Findex.ts&line=42&side=after`.

### Shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd K or P | Find a file |
| Ctrl/Cmd Shift F | Search source |
| Ctrl/Cmd F in the editor | Find within the current file/page |
| Ctrl/Cmd G | Jump to line |
| / outside a text field | Filter the file tree |
| Arrow keys / Enter in the tree | Navigate, expand, open |

## Export semantics

- A snapshot collects eligible files under one folder, respecting nested `.gitignore` files. Pruned directory exclusions count once, not once per unseen child. Global Git excludes are not used for non-Git snapshots.
- A ref diff compares exactly two commit trees, not their merge base. Both versions of changed files are embedded. Unchanged files are not part of a diff export.
- Working-tree mode compares HEAD to the current tracked files. Staged edits are included only as reflected in those files; it is not a staged-only review. Untracked files require `--include-untracked`.
- Diff exports include changed tracked paths even if ignored: ignore rules apply to snapshots and untracked discovery, not to hiding tracked changes.
- Renames use Git's rename detection. Renamed paths are checked against sensitive/exclusion filters on both sides.
- Repeat `--include` and `--exclude` to scope the export. Include rules are an OR; exclusions take precedence.
- `--dry-run` reports scope without writing HTML. Existing outputs require `--force` to replace.
- Common generated/dependency directories, repository internals, and sensitive filenames are excluded. `--include-generated`, `--include-sensitive`, and `--no-ignore` deliberately relax the relevant defaults. Repository internals remain excluded.
- Binary files, symlinks, submodules, and unsupported encodings appear as metadata rather than executable/rendered content. UTF-8 and BOM-marked UTF-16 are supported. Symlinks are never followed.
- Source changes during generation can affect a filesystem snapshot; export from a quiet checkout or fixed Git refs for reproducibility. Git helpers do not execute repository diff/textconv commands.

## Practical limits

This is not an unlimited-scale promise. A browser still has to load the complete HTML and its compressed blocks.

- Above 20,000 files or 100 MiB of uncompressed source, the CLI asks for confirmation. Non-interactive use needs `--allow-large`.
- Files over 2 MiB use 2,000-line pages without highlighting or inline diff. Before/after versions remain independently readable. Search scans the complete current version; in-file Find scans only the displayed page.
- Search returns up to 5,000 matching lines and explicitly reports the limit. It searches after versions, or before versions for deleted files; it does not search both revisions of every changed file.
- The map groups entries after the first eight; the group is drillable. Minimum tile areas preserve access to tiny/zero-byte entries, so areas are approximate.
- Diff computation has a time/depth budget and can use coarser change grouping on highly dissimilar files without discarding source.
- The 32 MiB cache limits retained decoded text, not total browser memory. A currently decoded large file, HTML parsing, and syntax parsers add overhead. Very long individual lines can still be expensive.
- Case-insensitive search uses Unicode lowercasing, not locale-specific or normalization-aware matching.
- File fragments refer to the included version, not to a live checkout. On narrow screens old-side line references open the before source; select Unified to return to the diff.

## Privacy and safety

The export includes source code. **Filename filtering is not secret scanning.** Review before sharing, including tracked files and Git history selected for diffs.

No telemetry, external fonts, CDN, fetch requests, or server. Content is compressed and embedded as data, rendered as text, and protected by a restrictive CSP. Never open exports from untrusted producers on the assumption that every HTML file is safe; these safeguards apply to files generated by this implementation.

The generator does not execute project code, build tools, Git external diff/textconv helpers, clean/smudge/process filters, or filesystem-monitor hooks. It uses Node.js filesystem APIs and read-only Git commands. Avoid concurrently changing filesystem links during export; fixed Git references are preferable for untrusted or mutable working directories.

## Development and validation

```sh
npm run typecheck
npm run build
npm test
npm run demo
npm run test:browser
npm run benchmark
```

Browser checks use installed Chrome/Edge on Windows or Playwright's installed Chromium. Set `GRAPHICODE_BROWSER` to an executable path if necessary. No browser is downloaded automatically. Screenshots and benchmark measurements are written to `test-results/`.

The benchmark measures 50 files, 2,000 files, and 20,000 files (about 100 MiB source). It records hardware, browser, generation, startup, cached switching, full search, main-thread heap, and generator peak memory. The memory figures are not total browser-process memory. Targets are startup below 3 seconds, frame-interval p95 below 33.3 ms, and cached switching below 100 ms on the recorded machine, not guarantees across devices.

## Structure

- `src/generator`: filesystem/Git collection, safety filters, content encoding, standalone export.
- `src/viewer`: UI shell, source/diff views, navigation/map, background content/search worker.
- `src/model.ts`: versioned manifest shared by generator and browser.
- `scripts`: build, sample exports, reproducible performance checks.
- `test`: generator correctness and offline browser scenarios.

Runtime dependencies and font licenses are bundled into every HTML under **Export information > Third-party notices**. No license is asserted for this project's source here.

### Measured on November 24, 2026

Synthetic fixtures, Windows 11, Intel i7-12700K, about 64 GiB RAM, Chrome 158, Node 24. Filesystem caches were not flushed; these are local observations, not device-independent guarantees.

| Included files | Source size | Generation | City ready | Frame interval p95 | Cached file switch | Full content scan |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | 50 KiB | 0.09 s | 0.36 s | 16.8 ms | 15 ms | 0.04 s |
| 2,000 | 3.9 MiB | 2.02 s | 0.27 s | 16.8 ms | 17 ms | 1.01 s |
| 20,000 | 100 MiB | 18.52 s | 0.75 s | 16.8 ms | 34 ms | 14.90 s |

Startup includes the layout worker and first city frame. Frame intervals measure requestAnimationFrame cadence during 120 frames of scripted zoom/pan, not input latency or GPU completion. Synchronous drawing p95 was 0.6 / 1.8 / 3.0 ms respectively. The 20,000-file scenario peaked at 422 visible features in that gesture sequence; the renderer enforces a 2,000-feature budget.

The largest HTML was about 108 MiB. Full scans run off the UI thread; they are not instant. Measurements and the exact environment are saved in `test-results/benchmark.json`. Browser memory is greater than the reported main-thread JavaScript heap because HTML storage, workers, and native allocations are separate.

Validation: typecheck, build, 13 unit/integration tests, and offline Chromium browser checks passed. Browser scenarios include canvas building selection, keyboard/wheel/drag/pinch navigation, inspector close/expand, saved camera reload, search, diffs, mobile layout, source injection safety, large-file paging, empty exports, and a synthetic 120-level branching folder tree. Firefox and Safari were not exercised.
## Code city

The default view is a top-down map. Zoom in to reveal neighborhoods and individual buildings; zoom out to aggregate them. Click a building to inspect source, or use Files / Search / Ctrl+K to fly to it. Close the inspector without resetting your location; Expand reader makes room for detailed diff review. On phones the inspector is a bottom sheet.

- Arrow keys pan, +/- zoom, Home fits the city, Enter explores the center, Escape visits the parent.
- The City navigation panel provides keyboard-accessible places; Files exposes every included path.
- Layout is deterministic for the same paths and sizes. Local coordinate frames support deeply nested folders. Large folders use explicitly labeled visual blocks.
- Canvas drawing is culled and limited to 2,000 visible features. Layout and source/search use separate embedded workers.
- Streets and rooftop shapes are visual decoration, **not dependency or symbol analysis**. Area approximates size with a cap to keep small files discoverable. Changed-file overlays do not rearrange the city.
- Diff maps contain only the included changed files, not an invented complete repository.
- Camera position and file/line references persist in the URL fragment. No network service, CDN, or map API is used.

The enriched Atlas demo contains clearly labeled illustrative source fixtures, not a buildable application. Syntax highlighting depends on bundled language support; unrecognized languages remain readable as plain text.



## Static connection journeys

Exports now include an optional offline relationship graph (`--relationships auto`, default; use `off` for source-only exports). Open **Explore connections**, choose a symbol, then Incoming, Outgoing, Journey, or Routes to. Click an arrow or result to inspect source evidence. Compare queries the before and after graphs independently; it never invents mixed-version routes.

The graph uses compiler-backed TS/JS call resolution and conservative Java/Kotlin syntax and receiver analysis. Explicit Retrofit/Spring HTTP bindings and JPA entity/table declarations are supported subsets, not universal framework or runtime coverage. Unsupported languages remain browsable. Dynamic calls remain unresolved; probable connections require opt-in for paths. Coverage is available in the panel.

Multi-repository export: `node dist/cli.js workspace workspace.json --out output/workspace.html`.

```json
{"version":1,"name":"Product","repositories":[{"id":"web","root":"./web"},{"id":"api","root":"./api","service":"backend"}],"bindings":[{"from":"web","service":"backend","baseUrl":"https://example.test"}]}
```

Repository filters and optional `base`/`head` comparisons apply independently. Contracts can be local OpenAPI files declared as `{"repo":"api","path":"openapi.yaml","service":"backend"}` in a `contracts` array. No project code, plugins, build tools, or remote contract references are executed.

Queries are bounded to 3 routes, depth 24, 50,000 states, 200,000 examined edges, and one second. Partial results are labeled. The map caps visible relationships at 200 and overview groups at 40; zoom reveals finer connections. Excluded, external and unroutable endpoints are not fabricated as buildings. Large-graph performance targets are not guarantees and require separate measurement.

### Relationship validation (2026-11-24)

`node --import tsx scripts/relations-benchmark.ts` measured the synthetic Node fixture plus CSR index at 72 ms / 155 MiB RSS for 200k symbols and 1M edges. `--stress` measured 358 ms / 461 MiB RSS for 1M symbols and 5M edges. These are indexing measurements on this machine, **not** browser startup, rendering, real-world analysis, or worst-case query guarantees. The deliberately shallow synthetic path queries do not represent arbitrary production journeys.

Generate the cross-repository example with `node --import tsx scripts/journey-demo.ts`: `output/journeys.html` and `output/journeys-diff.html`. Validate its offline source jumps and independent before/after routes with `node --import tsx test/journey-browser.ts`.

## Ten evidence lenses

Open **Explore insights** to explore capability journeys, state/errors, API/DTO contracts,
change impact, branch evidence, recovery/transactions, gates/schema, Git hotspots,
scenarios/tests and UI consumers. Cards open source evidence; symbol cards can continue
into Journeys. Selecting a file and enabling **Only selected file** finds its matching
state/scenario evidence and API/UI consumers. Solid edges are resolved static dependencies;
dashed links are probable dependencies or evidence associations, never runtime traces.

Explicit capabilities are optional workspace rules (paths may be repository-prefixed):

```json
{"features":[{"id":"orders","label":"Orders and payments","include":["web/src/orders/**","android/features/orders/**","api/orders/**"]}]}
```

Without rules, names/folders suggest capabilities labeled **inferred**. This focuses the
existing folder city rather than rearranging buildings, so comparing versions keeps the
same geography. Multiple capabilities may include a file.

```sh
node dist/cli.js snapshot ./project --history --history-refs main,release --history-limit 500 --out output/insights.html
node dist/cli.js workspace workspace.json --history --out output/workspace.html
node --import tsx scripts/insights-demo.ts
node --import tsx test/insights-browser.ts
node --import tsx scripts/insights-benchmark.ts
```

History is **off by default**, requires relationships and uses only explicit local refs:
no fetch, checkout, deployment query or analyzed project execution. The base/head ref plus
up to seven additional refs are pinned; 1-2000 non-merge commits per ref are scanned.
Only commits touching included files are embedded. Commit subjects and ref names can
contain private information: review the HTML before sharing. Limited metadata redaction
is not a secret scanner; the HTML still intentionally contains included source text.
Patch similarity is a normalized-diff candidate (max 100 small commits), not proof of
feature equivalence; absence, squashes and deployments remain unknown.

HTTP bindings optionally accept `stripPrefix` and `pathPrefix` (e.g. `/gateway` and `/v2`)
for explicit gateway rewrites. Spring Exchange annotations, literal fetch/Axios calls,
root tsconfig `baseUrl`/`paths`, JSX uses and unique interface implementation candidates
are supported subsets. No tsconfig plugins or inherited configs execute. Ambiguous DI,
dynamic routes and runtime state are not claimed resolved.

Limits: 2 MiB analyzed text per file, 1,500 insight facts per file/side, 500,000 total;
100 result cards per page, 200 map connections, 1.5-second query budget. Impact traversals
are separate per version and capped at 6 hops, 5,000 files and 200,000 edges. Queries run
in the embedded graph worker; partial results are marked. Unsupported languages remain
readable but do not gain invented semantic evidence. A test file is not a passing test;
config checks are not effective production values; shared writes are review points, not
proven races. Large history extraction is bounded per Git call, not constant-time.
