# CLAUDE.md

Guidance for Claude Code working in this repo. The README is the canonical
human-facing reference for the DSL and the published npm package; this file
focuses on what Claude needs to know to move efficiently.

## Repository purpose

A DSL and SVG renderer for [Event Modeling](https://eventmodeling.org)
diagrams, plus authoring skills for working with the DSL inside Claude
Code. Published as the `@howarddierking/mermaid-event-model` npm package
(default export registers as a Mermaid external diagram type; `./core`
subpath exposes standalone renderers for use without Mermaid).

Two diagram kinds: `eventModel` (the model itself — actors, commands,
events, read models, slices, etc.) and `sliceTests` (Given/When/Then test
specs for a single slice, sharing the visual vocabulary of `eventModel`).

## Layout at a glance

| Path | What |
| --- | --- |
| `event-model.js` / `event-model-mermaid.js` | Core renderer + Mermaid adapter for the `eventModel` diagram. |
| `slice-tests.js` / `slice-tests-mermaid.js` | Core renderer + Mermaid adapter for the `sliceTests` diagram. |
| `index.js`, `package.json` | npm entry points. Default export bundles both diagram definitions. |
| `model-viewer.html`, `core-playground.html` | Static demo pages (no build step). Open via a local HTTP server. |
| `blueprint_dsl.md` | Aggregate-based hotel-booking example. |
| `blueprint_dsl_dcb.md` | Same model in DCB style — no aggregates, `reads [...]` on commands. |
| `blueprint_dsl_fanin.md` | Fan-in stress test (16 events → one read model). |
| `blueprint_sliceTests.md` | Canonical `sliceTests` reference (four patterns). |
| `<model>-slices/` | Per-slice spec markdown, produced by the `spec-slices` skill. |
| `skills/` | Claude Code skills: `event-model`, `add-slices`, `spec-slices`, `add-tests`, `validate-completeness`, `create-event-model`. Also installable as a plugin (`.claude-plugin/plugin.json`). |

## DSL kinds (eventModel)

Indented under a top-level `eventModel` block. The README has the full
grammar — this is the cheatsheet:

- `actor <Name>` — top swimlane.
- `aggregate <Name>` — bottom swimlane (omit in DCB models).
- `ui:<Actor> <id>["Label"] { fields }`
- `command <id>["Label"] [reads [<event>, ...]] { fields }` — `reads` is a
  DCB consistency directive, **not** a flow edge; it never participates in
  ranking, slice membership, or arrow drawing.
- `domainEvent[:<Aggregate>] <id>["Label"] { fields }` — unqualified events
  land in a synthesized `Events` lane below `Time`.
- `externalEvent <id>["Label"] { fields }` — placed in a synthesized
  `External` lane above all actor lanes (pale-yellow fill).
- `readModel <id>["Label"] { fields }`
- `automation:<Actor> <id>["Label"]`
- `slice <id>["Label"]` — followed by an indented block of `-->` edges
  whose referenced nodes are grouped into a dashed bounding box.
- Field types: `string`, `int`, `float`, `decimal`, `boolean`, `date`,
  `timestamp`, `UUID`.

Canonical flow pattern: `ui → command → domainEvent → readModel → (ui | automation)`.

## DSL kinds (sliceTests)

Each test is one Given / When / Then card. Items inside reuse the
`eventModel` visual vocabulary plus one sliceTests-only kind:

- `domainEvent`, `externalEvent`, `command`, `readModel`, `automation`,
  `ui` — same colors and shapes as `eventModel`.
- `error["<message>"]` — **sliceTests only.** Expected rejection outcome
  inside a `then` block. Renders as a red box (`#f87171` fill / `#7f1d1d`
  stroke, matching the 400/900 palette pattern). When the slice is code-
  generated, each `error[...]` maps to throwing the target framework's
  domain exception with the exact message string used verbatim.

`then` may contain a mix of emitted events, read-model states, and errors.

## Conventions

- Element ids are lowercase/snake_case; human-readable text goes in the
  `["..."]` label.
- DSL files are markdown — DSL lives inside a fenced ```mermaid block whose
  first content line is `eventModel` or `sliceTests`. The renderers tolerate
  either raw DSL or markdown wrappers, so any examples shown here are the
  body of the fence.
- Slice spec files (`<model>-slices/*.md`) have three sections: `## Model`
  (mechanically derived — refreshed by `spec-slices` on re-run), `## Description`
  (user prose), `## Tests` (user-authored `sliceTests` DSL). Description
  and Tests are user-owned and must round-trip unchanged.

## Working in this repo

- **No JS build step.** The renderers ship as plain ES modules; the demo
  pages load `d3`/`mermaid` from a CDN. To run demos locally:
  `python3 -m http.server 8000` then open `model-viewer.html`.
- **JS tests don't exist.** When changing parser regexes or layout, sanity-
  check via a quick Node one-liner against the regex or by opening the
  viewer against the relevant `blueprint_*.md`.

## Notes for skill changes

- `spec-slices` writes per-slice spec files from a parsed `eventModel`. Its
  template lives at `skills/spec-slices/template.md`; editing the template
  affects newly-stamped files only — existing user content is never
  retroactively rewritten.
- `add-slices` rewrites the slice declarations in an `eventModel` block;
  it strips existing slices first to stay idempotent. It ignores `reads`.
- The grammar of `sliceTests` is enforced by a regex in `slice-tests.js`
  (`parseSliceTests`). When adding a new item kind, update both the regex
  AND `ITEM_STYLES`, AND mention it in the grammar comment at the top of
  the file AND in the README's "Slice Tests" section AND in this file.
