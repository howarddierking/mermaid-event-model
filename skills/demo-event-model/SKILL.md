---
name: demo-event-model
description: Write the canonical hotel-booking demo Event Model DSL plus a Mermaid demo HTML page that renders it. Useful for resetting the reference DSL or seeding a new file with a working example that exercises every DSL feature (actors, aggregates, UIs, commands, domain events, read models, automations, data sections, slices). The DSL defaults to `blueprint_dsl` in the project root; the HTML is always written as a sibling named `event-model-mermaid.html`.
argument-hint: [target-dsl-path]
---

# Demo Event Model Generator

Write the canonical hotel-booking Event Model DSL to a target file, plus a Mermaid demo HTML page beside it that renders the DSL.

## Input

The argument `$ARGUMENTS` is the target path for the DSL file. If no argument is provided, default to `blueprint_dsl` in the project root.

## What to do

1. Locate the template files. Use the `Bash` tool with `dirname` on the path to this `SKILL.md` to find the skill directory — do not hard-code an absolute path. The two templates are:
   - `template.dsl` — the canonical DSL.
   - `template.html` — the Mermaid demo HTML page.

2. Determine the two output paths:
   - **DSL output**: the `$ARGUMENTS` path (or `blueprint_dsl` if absent).
   - **HTML output**: a sibling of the DSL output, always named `event-model-mermaid.html`.

3. Write `template.dsl` verbatim to the DSL output. Preserve tab indentation exactly — the DSL parser is indent-aware and uses tabs.

4. Write `template.html` verbatim to the HTML output.

5. If either output file already exists, confirm with the user before overwriting (per file).

6. Confirm to the user what you wrote and where, and remind them that the demo page expects the DSL file to be named `blueprint_dsl` by default. If the user passed a non-default DSL path, tell them to either rename the DSL to `blueprint_dsl` or load the page with `?dsl=<their-filename>` to point the demo at it.

## What the templates contain

### `template.dsl`

A complete hotel-booking event model that exercises every DSL feature:

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

A Mermaid integration demo page that:

- Registers Event Model as an external Mermaid diagram type
- Loads the DSL via `fetch` and polls every second for changes (live reload)
- Accepts a `?dsl=<filename>` query param to override the default source

The page loads `d3`, `mermaid`, and the `@howarddierking/mermaid-event-model` package via jsDelivr through a browser importmap, so it works with no install or build step — the user just serves the directory (e.g. `python3 -m http.server`) and opens the page.

## Important

- Do NOT modify the template files themselves; this skill only copies them to the target.
- Confirm overwrites file-by-file — the user may want to keep one and replace the other.
