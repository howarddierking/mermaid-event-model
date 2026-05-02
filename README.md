# Event Model

A small DSL and SVG renderer for [Event Modeling](https://eventmodeling.org) diagrams. You describe a system as a sequence of UIs, commands, domain events, read models, and automations; the renderer lays it out as a strict horizontal timeline with swimlanes — actors on top, aggregates on the bottom, commands and read models on the central time axis — so every element in the same causal step lines up vertically across all lanes.

![reference blueprint](blueprint_model_only.jpeg)

## Installation

### As an npm package

```sh
npm install @howarddierking/mermaid-event-model d3 mermaid
```

`d3` and `mermaid` are peer dependencies. `mermaid` is optional — you only need it if you use the Mermaid adapter (the default export); the `./core` subpath entry (for standalone SVG rendering) only requires `d3`.

The default export is an array of every diagram definition this package ships (`eventModel` and `sliceTests`), ready to register with Mermaid in one call:

```js
import mermaid from 'mermaid';
import diagramDefinitions from '@howarddierking/mermaid-event-model';

await mermaid.registerExternalDiagrams(diagramDefinitions);
mermaid.initialize({ startOnLoad: true });
```

Any fenced block whose first line is `eventModel` or `sliceTests` will now be routed to the right renderer. To register only one of them, pull the named export:

```js
import { eventModelDefinition, sliceTestsDefinition }
  from '@howarddierking/mermaid-event-model';

await mermaid.registerExternalDiagrams([eventModelDefinition]); // event-model only
```

For standalone use without Mermaid:

```js
import { renderEventModel } from '@howarddierking/mermaid-event-model/core';
import { renderSliceTests } from '@howarddierking/mermaid-event-model/slice-tests-core';

renderEventModel(dslSource, document.getElementById('diagram'));
renderSliceTests(testSource, document.getElementById('tests'));
```

### Via CDN (no build step)

The package is mirrored on jsDelivr. Pair it with an importmap so the bare `d3` and `mermaid` imports resolve:

```html
<script type="importmap">
{
  "imports": {
    "d3": "https://cdn.jsdelivr.net/npm/d3@7/+esm",
    "mermaid": "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs",
    "@howarddierking/mermaid-event-model": "https://cdn.jsdelivr.net/npm/@howarddierking/mermaid-event-model/index.js"
  }
}
</script>
<script type="module">
  import mermaid from 'mermaid';
  import diagramDefinitions from '@howarddierking/mermaid-event-model';

  await mermaid.registerExternalDiagrams(diagramDefinitions);
  mermaid.initialize({ startOnLoad: true });
</script>
```

## Running the examples

Two demo pages, served as static HTML with no build step (mermaid, d3, and marked are loaded from a CDN at runtime):

| Page | What it shows |
| --- | --- |
| `model-viewer.html` | **Canonical demo.** Renders a `.md` model file (markdown prose + the embedded `eventModel` diagram), with a sidebar that lists every slice spec under the matching `<model>-slices/` directory. Switch models with `?model=<basename>`. |
| `core-playground.html` | Standalone DSL textarea + Render button, exercising the core renderer directly without Mermaid. Useful for diagnosing whether a layout bug is in the renderer or in the Mermaid integration. |

Start a local server and open the viewer:

```sh
# from the repo root
python3 -m http.server 8000
```

Then open <http://localhost:8000/model-viewer.html>.

A local HTTP server is required because the JS files are ES modules and most browsers block module imports over `file://`. The Python server's directory listing is also what powers the slice-spec sidebar.

The viewer loads `blueprint_dsl_fanin.md` by default and polls for changes every 1.5s — edit any `.md` and the open page re-renders. Try other models with `?model=blueprint_dsl`, `?model=blueprint_dsl_dcb`, or `?model=blueprint_sliceTests`.

The rendered diagram scrolls horizontally — each element gets its own column, so wide models overflow the right edge rather than compressing.

## The DSL

DSL files are markdown — each one is a `.md` file whose DSL lives inside a fenced ```mermaid block. See [`blueprint_dsl.md`](blueprint_dsl.md) for a full aggregate-based example (a hotel booking system) and [`blueprint_dsl_dcb.md`](blueprint_dsl_dcb.md) for the same model rewritten in DCB style (no aggregates, with `reads` clauses on commands). The renderer's parser tolerates either raw DSL or markdown wrappers, so anywhere this README shows raw `eventModel ...` syntax, that's the body of the fenced block. The grammar:

```
eventModel
    actor <Name>
    aggregate <Name>                                        (optional — DCB models omit aggregates)

    ui:<Actor>            <id>["Label"]
    command               <id>["Label"] [reads [<event>, ...]]
    domainEvent[:<Agg>]   <id>["Label"]
    externalEvent         <id>["Label"]
    readModel             <id>["Label"]
    automation:<Actor>    <id>["Label"]

    <id> --> <id>

    slice <id>["Label"]
        <id> --> <id>
```

- **actor** — declares a top swimlane (e.g. `Manager`, `Guest`).
- **aggregate** — declares a bottom swimlane representing a bounded context (e.g. `Inventory`, `Payment`). Optional; omit when modeling DCB-style.
- **ui** — a screen owned by an actor; placed in that actor's lane.
- **command** — an intent issued from a UI or automation; placed in the Time lane.
- **domainEvent** — a fact emitted by an aggregate; placed in that aggregate's lane. If the `:<Aggregate>` qualifier is omitted, the event lands in a synthesized `Events` lane below `Time`.
- **externalEvent** — a fact originating outside the system (e.g. a webhook from a third-party service or a partner integration). Placed in a synthesized `External` lane at the very top of the diagram, above all actor lanes. Rendered with a pale-yellow fill to distinguish from internal domain events.
- **readModel** — a projection read by UIs or automations; placed in the Time lane.
- **automation** — an automated process owned by an actor; placed in that actor's lane.
- **-->** — a flow edge. The canonical pattern is `ui → command → domainEvent → readModel → (ui | automation)`.

Labels are optional; if omitted, the identifier is used as the label.

### Data sections

Commands, domain events, external events, UIs, and read models can include a brace-delimited data section listing typed fields — similar to a Mermaid class diagram:

```
command bookRoom["Book Room"] {
    guestId: UUID
    roomId: UUID
    checkIn: date
    checkOut: date
}
```

Supported types: `string`, `int`, `float`, `decimal`, `boolean`, `date`, `timestamp`, `UUID`.

The renderer draws these as a two-section node: the label on top, a divider, and the field list below. Clicking a node with fields collapses or expands the data section. Node width is automatically sized to fit the widest label or field text.

### Dynamic Consistency Boundaries (DCB)

In DCB-style models, commands aren't bound to a single aggregate; instead each command declares which past event types it must replay to enforce consistency. Express this with an optional `reads [...]` clause on the command, between the label and the data block:

```
command bookRoom["Book Room"] reads [Registered, ra, booked] {
    guestId: UUID
    roomId: UUID
    checkIn: date
    checkOut: date
}

command hotelProximityTranslator["Hotel Proximity Translator"] reads [checkedIn, checkedOut]
```

The renderer adds a third section to the command box, below the data fields, listing each consumed event prefixed with `«`. The chevron toggle collapses fields and reads together.

`reads` is a directive to the event-sourcing framework about which events to hydrate — **not** a flow edge. It does not affect column ranking, slice membership, or arrow drawing. Auto-slicing (`/mermaid-event-model:add-slices`) ignores `reads` entirely.

DCB models typically omit `aggregate` declarations. Domain events declared without a `:<Aggregate>` qualifier land in a synthesized `Events` lane below `Time`, so the diagram preserves the actors-on-top, events-on-bottom layout without needing aggregate names. Aggregate-based and DCB-based syntax can mix in the same file: aggregate-qualified events still flow to their named lane.

### Slices

A **slice** represents a vertical slice in Event Modeling terminology — a cohesive unit of behavior that cuts across UIs, commands, events, and read models. Declare a slice followed by an indented block of edges; the referenced nodes become the slice's members.

```
slice registration_slice["Registration"]
    reg_ui-->Register
    Register-->Registered
```

The renderer draws a dashed bounding box around the member nodes with the slice's label centered at the top of the box. The indented edges still participate in the overall flow — the slice just groups them visually. Hovering over a slice border highlights it (thicker, darker stroke) so you can identify individual slices when they overlap.

## Using it as a Mermaid chart type

Once registered (see [Installation](#installation)), any fenced block whose first line is `eventModel` is routed to our renderer:

```html
<pre class="mermaid">
eventModel
  actor Guest
  aggregate Inventory
  ui:Guest booking_ui["Booking Screen"] {
    roomId: UUID
    checkIn: date
    checkOut: date
  }
  command bookRoom["Book Room"] {
    guestId: UUID
    roomId: UUID
    checkIn: date
    checkOut: date
  }
  domainEvent:Inventory booked["Room Booked"] {
    bookingId: UUID
    guestId: UUID
    roomId: UUID
    bookedAt: timestamp
  }
  booking_ui-->bookRoom
  bookRoom-->booked
</pre>
```

The adapter (`event-model-mermaid.js`) implements Mermaid's external-diagram contract: `detector` matches the `eventModel` header, `parser.parse` calls `parseEventModel` and stashes the model, and `renderer.draw` grabs the `<svg>` Mermaid has already inserted into the DOM and populates it via the shared `drawInto` routine — the same one the standalone demo uses, so any visual change lands in both paths.

## How layout works

The renderer (`event-model.js`) has three stages:

1. **Parse** — `parseEventModel(src)` reads the DSL into `{ actors, aggregates, elements, edges, slices }`. Each element carries optional `fields` (data section) and `reads` (DCB consume list).
2. **Rank** — `computeRanks` runs a DFS to identify back-edges (so cycles like `paymentSucceeded ↔ paymentsToProcess` don't blow up), then performs Kahn's topological sort of the forward DAG with declaration order as the tiebreaker. Each element gets a unique column — no two elements share an x-position, even across lanes. `reads` is ignored at this stage since it isn't a flow edge.
3. **Layout + draw** — `layoutEventModel` builds the lane stack (an optional `External` lane on top → actors → Time → aggregates → an optional `Events` lane on the bottom; the two synthesized lanes only appear when the model contains an `externalEvent` or an unqualified `domainEvent`, respectively), places each element at `(column × colWidth, lane.y)`, and auto-sizes node width and height to fit content; `renderEventModel(src, target)` uses d3 data joins to draw lane bands, a dashed time axis, edges (as vertical bezier curves connecting top/bottom of nodes across lanes), and multi-section nodes with collapsible data and reads sections.

Because columns are a true topological order, the horizontal position of any node is its earliest possible time given the causal edges you declared — the core property an Event Model needs.

## Claude Code plugin

This repo doubles as a [Claude Code plugin](https://code.claude.com/docs/en/plugins) that exposes authoring skills for Event Model DSL files.

Install it in any project where you're authoring Event Models:

```
/plugin install howarddierking/mermaid-event-model
```

| Skill | Description |
| --- | --- |
| `/mermaid-event-model:event-model` | Authors or extends a DSL file from a natural-language description. Adds actors, aggregates, UIs, commands, events, read models, and automations using the project's grammar and conventions. Resolves the target file from the argument or, if absent, the most recently referenced file in the conversation. |
| `/mermaid-event-model:add-slices` | Analyzes data flow in a DSL file and proposes vertical slice groupings. Identifies command slices (ui → command → event) and read slices (event → readModel → ui/automation), presents them for review, then applies them. |
| `/mermaid-event-model:spec-slices` | Stamps out one markdown specification file per `slice` declared in the DSL into a sibling directory `<dsl-file>-slices/`. Each spec has a description (prose intent) and a tests section (in the future `eventModelSlice` DSL). Existing files are preserved. Intended to drive both validation and code generation downstream. |
| `/mermaid-event-model:validate-completeness` | Checks the [information completeness principle](https://www.pradhan.is/blogs/event-modelling-best-practices) — traces every field in every UI and read model backward through events and commands to verify no data is assumed or missing. Reports gaps with suggested fixes. |
| `/mermaid-event-model:create-event-model` | Seeds a project with a working Event Model: writes a markdown file (DSL inside a fenced `mermaid` block, defaults to `blueprint_dsl.md`) plus a sibling `model-viewer.html` page that renders it and lists any companion slice specs. Useful for bootstrapping a new model or resetting to the reference example. |

Each skill accepts an optional target path; they default to `blueprint_dsl.md`.

### Local plugin development

The plugin skills live at [`skills/`](skills/) and the manifest at [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json). The top-level `.claude/skills/` is a symlink to `skills/` so the skills also work as project-scoped slash commands while editing this repo (without the `mermaid-event-model:` namespace prefix).

## Files

- `model-viewer.html` — canonical demo: renders a model `.md` plus the linked `<model>-slices/` directory, with sidebar navigation.
- `core-playground.html` — DSL textarea + Render button exercising the core renderer directly (no Mermaid).
- `index.js` — combined Mermaid registration entry: default export is the array of every diagram definition this package ships.
- `event-model.js` — core ES module: `parseEventModel`, `computeRanks`, `layoutEventModel`, `drawInto`, `renderEventModel`. Takes `d3` as a peer dependency.
- `event-model-mermaid.js` — Mermaid adapter that registers `eventModel` as an external diagram type.
- `slice-tests.js` — core ES module for the Slice Tests diagram: `parseSliceTests`, `layoutSliceTests`, `drawInto`, `renderSliceTests`.
- `slice-tests-mermaid.js` — Mermaid adapter that registers `sliceTests` as an external diagram type.
- `blueprint_dsl.md` — reference DSL (aggregate-based), DSL embedded in a `mermaid` fenced block.
- `blueprint_dsl_dcb.md` — same model rewritten in DCB style: no aggregates, with `reads [...]` clauses on commands.
- `blueprint_dsl_fanin.md` — fan-in stress test: 16 events updating one read model.
- `blueprint_sliceTests.md` — Slice Tests reference DSL (Given / When / Then patterns).
- `<model>-slices/` — per-model directories of slice spec markdown files, written by the `spec-slices` skill.
- `skills/` — Claude Code skills for DSL authoring (auto-slicing, completeness validation, demo generator).
- `.claude-plugin/plugin.json` — Manifest that makes this repo installable as a Claude Code plugin.
- `.claude/skills/` — symlink to `skills/` so the same skills also work as local project-scoped commands while developing in this repo.
- `blueprint_model_only.jpeg`, `blueprint_large.jpg` — the target visuals the renderer approximates.
