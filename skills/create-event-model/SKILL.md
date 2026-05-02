---
name: create-event-model
description: Seed a project with a working Event Model. Writes (1) a markdown file containing the canonical hotel-booking DSL inside a `mermaid` fenced block, and (2) a `model-viewer.html` page that renders that markdown plus any sibling `<model>-slices/` directory created later by the `spec-slices` skill. Useful for bootstrapping a new model or resetting to the reference example. The model defaults to `blueprint_dsl.md`; the viewer is always written as a sibling named `model-viewer.html`.
argument-hint: [target-model-path]
---

# Create Event Model

Seed a project with a working Event Model: a markdown file wrapping the canonical hotel-booking DSL, plus a `model-viewer.html` page that renders it (and lists any companion slice specs in a sidebar).

## Input

The argument `$ARGUMENTS` is the target path for the model file. If no argument is provided, default to `blueprint_dsl.md` in the project root. If the argument doesn't already end in `.md`, append `.md`.

## What to do

1. Locate the template files. Use the `Bash` tool with `dirname` on the path to this `SKILL.md` to find the skill directory — do not hard-code an absolute path. The two templates are:
   - `template.md` — markdown wrapper containing the canonical DSL inside a fenced `mermaid` block. Has a `{{MODEL_NAME}}` placeholder in the title.
   - `template.html` — the `model-viewer.html` page (markdown + diagram + slice-spec sidebar). Also has a `{{MODEL_NAME}}` placeholder for the default model the viewer loads.

2. Determine the two output paths:
   - **Model output**: the `$ARGUMENTS` path (or `blueprint_dsl.md` if absent), with `.md` appended if missing.
   - **Viewer output**: a sibling of the model output, always named `model-viewer.html`.

3. Compute the model basename: the model output filename without its `.md` extension. This is the `{{MODEL_NAME}}` substitution value (e.g. `blueprint_dsl.md` → `blueprint_dsl`).

4. Write `template.md` to the model output, substituting `{{MODEL_NAME}}` with the basename. Preserve tab indentation in the embedded DSL exactly — the parser is indent-aware and uses tabs.

5. Write `template.html` to the viewer output, substituting `{{MODEL_NAME}}` with the same basename so the viewer loads the correct model by default.

6. If either output file already exists, confirm with the user before overwriting (per file).

7. Confirm to the user what you wrote and where, plus the command to view it:

   ```sh
   python3 -m http.server 8000
   # then open http://localhost:8000/model-viewer.html
   ```

   The viewer accepts `?model=<basename>` to load a different model in the same directory. The slice-spec sidebar fills in once the user runs `/mermaid-event-model:spec-slices` against the model.

## What the templates contain

### `template.md`

A markdown file wrapping the canonical hotel-booking event model in a fenced `mermaid` block. The DSL itself exercises every feature:

- **Actors**: Manager, Guest
- **Aggregates**: Inventory, Auth, Payment, GPS
- **UIs** with data sections: Registration, Room Management, Booking, Maintenance, Check-in, Payment, Sales Report
- **Commands** with data sections: Register, Add Room, Book Room, Ready Room, Check-in, Checked Out, Pay, Process Payment, and a fieldless `hotelProximityTranslator`
- **Domain events** with data sections: Registered, Room Added, Room Booked, Room Readied, Checked In, Position Updated, Guest Left Hotel, Checked Out, Payment Requested, Payment Succeeded
- **External events** with data sections: Gateway Confirmed (a payment-gateway webhook that feeds into `processPayment`)
- **Read models** with data sections: Room Availability, Cleaning Schedule, Guest Roster, Payments to Process, Sales Report
- **Automations**: Check-out Automation (Manager), Payment Processor (Guest)
- **Slices** covering every edge in the model (16 slices total), demonstrating both command slices (ui/automation → command → event) and read slices (event → readModel → ui/automation)
- **A cycle**: `paymentSucceeded ↔ paymentsToProcess` — exercises the renderer's back-edge handling

### `template.html`

A `model-viewer.html` page that:

- Renders the model `.md` (markdown prose around the embedded `eventModel` diagram) in the main pane
- Lists every spec under `<model>-slices/` in a sidebar, falling back to "(no slice specs found)" until the user runs `spec-slices`
- Polls the active file every 1.5 seconds and re-renders on changes (live reload)
- Loads `d3`, `mermaid`, `marked`, and the `@howarddierking/mermaid-event-model` package via jsDelivr through a browser importmap, so it works with no install or build step beyond a static file server

## Important

- Do NOT modify the template files themselves; this skill only copies them to the target with placeholder substitution.
- Confirm overwrites file-by-file — the user may want to keep one and replace the other.
