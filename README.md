# Event Model

A small DSL and SVG renderer for [Event Modeling](https://eventmodeling.org) diagrams. You describe a system as a sequence of UIs, commands, domain events, read models, and automations; the renderer lays it out as a strict horizontal timeline with swimlanes — actors on top, aggregates on the bottom, commands and read models on the central time axis — so every element in the same causal step lines up vertically across all lanes.

![reference blueprint](blueprint_model_only.jpeg)

## Running the examples

There are two demo pages, both served as static HTML with no build step (mermaid and d3 are loaded from a CDN at runtime):

| Page | What it shows |
| --- | --- |
| `event-model-mermaid.html` | **Recommended.** Registers Event Model as a [Mermaid external diagram](https://mermaid.js.org/config/usage.html#external-diagrams) and renders a `<pre class="mermaid">eventModel …</pre>` block — the same way you'd embed it inside a Markdown/Docusaurus/MkDocs site that already uses mermaid. |
| `event-model.html` | Standalone demo with a DSL textarea and a Render button, no mermaid dependency. Useful for iterating on the DSL. |

Start a local server and open the mermaid demo:

```sh
# from the repo root
python3 -m http.server 8000
```

Then open <http://localhost:8000/event-model-mermaid.html>.

A local HTTP server is required because the JS files are ES modules and most browsers block module imports over `file://`.

The mermaid demo loads `blueprint_dsl` via `fetch` and polls for changes every second — edit the file and the diagram updates automatically without a manual reload.

The rendered diagram scrolls horizontally — each element gets its own column, so wide models overflow the right edge rather than compressing.

## The DSL

See [`blueprint_dsl`](blueprint_dsl) for a full example (a hotel booking system). The grammar:

```
eventModel
    actor <Name>
    aggregate <Name>

    ui:<Actor>         <id>["Label"]
    command            <id>["Label"]
    domainEvent:<Agg>  <id>["Label"]
    readModel          <id>["Label"]
    automation:<Actor> <id>["Label"]

    <id> --> <id>

    slice <id>["Label"]
        <id> --> <id>
```

- **actor** — declares a top swimlane (e.g. `Manager`, `Guest`).
- **aggregate** — declares a bottom swimlane representing a bounded context (e.g. `Inventory`, `Payment`).
- **ui** — a screen owned by an actor; placed in that actor's lane.
- **command** — an intent issued from a UI or automation; placed in the Time lane.
- **domainEvent** — a fact emitted by an aggregate; placed in that aggregate's lane.
- **readModel** — a projection read by UIs or automations; placed in the Time lane.
- **automation** — an automated process owned by an actor; placed in that actor's lane.
- **-->** — a flow edge. The canonical pattern is `ui → command → domainEvent → readModel → (ui | automation)`.

Labels are optional; if omitted, the identifier is used as the label.

### Data sections

Commands, domain events, UIs, and read models can include a brace-delimited data section listing typed fields — similar to a Mermaid class diagram:

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

### Slices

A **slice** represents a vertical slice in Event Modeling terminology — a cohesive unit of behavior that cuts across UIs, commands, events, and read models. Declare a slice followed by an indented block of edges; the referenced nodes become the slice's members.

```
slice registration_slice["Registration"]
    reg_ui-->Register
    Register-->Registered
```

The renderer draws a dashed bounding box around the member nodes with the slice's label centered at the top of the box. The indented edges still participate in the overall flow — the slice just groups them visually. Hovering over a slice border highlights it (thicker, darker stroke) so you can identify individual slices when they overlap.

## Using it as a Mermaid chart type

In any page that already uses Mermaid:

```js
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
import eventModelDefinition from './event-model-mermaid.js';

await mermaid.registerExternalDiagrams([eventModelDefinition]);
mermaid.initialize({ startOnLoad: true });
```

Then any fenced block whose first line is `eventModel` is routed to our renderer:

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

1. **Parse** — `parseEventModel(src)` reads the DSL into `{ actors, aggregates, elements, edges }`.
2. **Rank** — `computeRanks` runs a DFS to identify back-edges (so cycles like `paymentSucceeded ↔ paymentsToProcess` don't blow up), then performs Kahn's topological sort of the forward DAG with declaration order as the tiebreaker. Each element gets a unique column — no two elements share an x-position, even across lanes.
3. **Layout + draw** — `layoutEventModel` places each element at `(column × colWidth, lane.y)` and auto-sizes node width to fit content; `renderEventModel(src, target)` uses d3 data joins to draw lane bands, a dashed time axis, edges (as vertical bezier curves connecting top/bottom of nodes across lanes), and two-section nodes with collapsible data fields.

Because columns are a true topological order, the horizontal position of any node is its earliest possible time given the causal edges you declared — the core property an Event Model needs.

## Claude Code skills

The `.claude/skills/` directory contains custom slash commands for working with Event Model DSL files:

| Skill | Description |
| --- | --- |
| `/add-slices` | Analyzes data flow in a DSL file and proposes vertical slice groupings. Identifies command slices (ui → command → event) and read slices (event → readModel → ui/automation), presents them for review, then applies them. |
| `/validate-completeness` | Checks the [information completeness principle](https://www.pradhan.is/blogs/event-modelling-best-practices) — traces every field in every UI and read model backward through events and commands to verify no data is assumed or missing. Reports gaps with suggested fixes. |

Run `/add-slices blueprint_dsl` or `/validate-completeness blueprint_dsl` (both default to `blueprint_dsl` if no argument is given).

## Files

- `event-model-mermaid.html` — demo using Mermaid's external-diagram API (recommended).
- `event-model-mermaid.js` — adapter that registers the DSL as a Mermaid diagram type.
- `event-model.html` — standalone demo with a DSL textarea and Render button.
- `event-model.js` — core ES module with `parseEventModel`, `computeRanks`, `layoutEventModel`, `drawInto`, and `renderEventModel`. Imports d3 v7 from jsDelivr.
- `blueprint_dsl` — reference DSL source.
- `.claude/skills/` — Claude Code slash commands for DSL automation.
- `blueprint_model_only.jpeg`, `blueprint_large.jpg` — the target visuals the renderer approximates.
