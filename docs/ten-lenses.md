# Ten-lens delivery checklist

The implementation stays inside graphiCode. Input projects are never executed or modified.

1. Feature journeys: explicit workspace feature globs; inferred fallback membership; per-capability map focus and source drilldown.
2. State/errors: indexed MVI/Redux dispatch, branch labels, error codes, navigation and evidence associations.
3. Contracts: annotation/literal HTTP endpoints, DTO fields, comparison, Spring Exchange client bindings and explicit path rewrites.
4. Impact: independent before/after incoming traversals, direct/transitive/probable labeling, bounded cancellation.
5. Branch matrix: opt-in local pinned refs, scoped observed commits, normalized-patch candidates; no deploy/squash inference.
6. Recovery: callback/scheduler/transaction/claim evidence and shared-write review points.
7. Gates: configuration keys/checks and schema declarations; values omitted, runtime activation unknown.
8. History: bounded commit timeline, revert links, hotspots, small-commit co-change distinct from dependencies.
9. Scenarios: explicit scenario IDs, Flow/Markdown source references and test-source links; never infer passing status.
10. Components: Compose/JSX candidates, consumer files and symbol graph tracing; no rendering/visual-regression claims.

Status: implemented and validated on 2026-11-24. Each lens has worker-based queries, pagination, source evidence and map projection. Feature focus preserves folder geography rather than rearranging buildings. The first release is conservative static analysis, not universal semantic or runtime analysis.

## Validation

- TypeScript check, production build and 40 unit/integration tests passed.
- Offline Chrome checks cover all ten lenses, contract comparison, source jumps, API/UI consumers, version-aware symbol journeys, panel switching and mobile. Existing source/map and journey browser suites also passed.
- Synthetic Node benchmark: 20,000 files, 200,000 symbols, 1,000,000 edges and 500,000 facts. Index: about 97 ms; feature query: 55 ms; state query: 852 ms. These are local observations, not browser/startup or arbitrary-codebase guarantees. Impact in the chain fixture is explicitly partial at six hops.
- No Bajet project was modified or executed. No Gradle/Maven execution, commit or push.
- Known limits: syntax/name-based associations, bounded local Git windows, no runtime traces, deployment state, exhaustive dynamic DI or proof of test success.
