---
name: event-model
description: Author or extend an Event Model DSL file from a natural-language description. Adds actors, aggregates, UIs, commands, domain events, external events, read models, and automations following the project's grammar and conventions. Use this when the user wants to model a new system, add a new flow to an existing model, or sketch a missing piece — not for adding slices (use `add-slices` for that) or validating completeness (use `validate-completeness`).
argument-hint: [dsl-file-path] <description of what to model>
---

# Event Model DSL Authoring

You are an Event Modeler. Edit (or create) an Event Model DSL file based on the user's description, using the grammar and conventions established in this repository.

## Input

The argument `$ARGUMENTS` is freeform — typically a description of what to add, optionally prefixed by a DSL file path. Examples:

- `blueprint_dsl Add a refund pathway when an order is returned`
- `Add a "forgot password" flow` (no path → resolve from session context, see below)
- `./models/billing.dsl Model a subscription renewal cycle`

### Resolving the target file

1. If `$ARGUMENTS` contains an explicit file path (anything matching a DSL filename in this project, e.g. `blueprint_dsl`, `blueprint_dsl_dcb`, `blueprint_dsl_fanin`, or a `.dsl` path), use that.
2. Otherwise, scan the **current conversation context** for the most recently referenced DSL file. Preference order: a file the user explicitly named in their last message, a file you most recently read or wrote, then any file the renderer demos pointed at.
3. If still ambiguous, ask the user once which file before proceeding.
4. As an absolute fallback, use `blueprint_dsl` in the project root.

If the target file does not exist yet, create it with the `eventModel` header and any actors/aggregates the description implies.

## DSL grammar (cheat sheet)

The full specification lives in [`README.md`](../../README.md). Read it if any of the rules below feel underspecified for the user's request. The high-points:

```
eventModel
    actor <Name>
    aggregate <Name>                                  # optional — DCB models omit aggregates

    ui:<Actor>            <id>["Label"]
    command               <id>["Label"] [reads [<event>, ...]]
    domainEvent[:<Agg>]   <id>["Label"]               # `:<Agg>` qualifier optional
    externalEvent         <id>["Label"]               # facts originating outside the system
    readModel             <id>["Label"]
    automation:<Actor>    <id>["Label"]

    <id> --> <id>                                     # flow edge

    slice <id>["Label"]                               # vertical slice — DON'T author these here
        <id> --> <id>
```

Optional brace-delimited data sections (typed fields, one per line) are supported on `ui`, `command`, `domainEvent`, `externalEvent`, and `readModel`:

```
command bookRoom["Book Room"] {
    guestId: UUID
    roomId: UUID
    checkIn: date
    checkOut: date
}
```

Supported field types: `string`, `int`, `float`, `decimal`, `boolean`, `date`, `timestamp`, `UUID`.

## Reference DSL files

Read whichever of these matches the pattern the user is describing — they are the canonical examples for each style:

- [`blueprint_dsl`](../../blueprint_dsl) — aggregate-based hotel booking. Use this as the default reference for ordinary CQRS/event-sourcing models.
- [`blueprint_dsl_dcb`](../../blueprint_dsl_dcb) — Dynamic Consistency Boundary variant: no aggregates, commands declare `reads [...]` clauses listing the event types they replay for consistency. Use when the user asks for DCB or "no aggregates".
- [`blueprint_dsl_fanin`](../../blueprint_dsl_fanin) — many events updating one read model (a customer activity timeline). Use when modeling a feed, audit log, or aggregated view.

## Conventions

- **Indentation is tabs**, not spaces. Every line under `eventModel` is one tab in; brace bodies and slice edges go one tab deeper. The parser is indent-aware.
- Use `camelCase` for element ids (`bookRoom`, `paymentSucceeded`) and `snake_case` for slice ids (`request_payment`). Put human-readable text in `["..."]` labels.
- The canonical flow is `ui → command → domainEvent → readModel → (ui | automation)`. Stay on the canonical pattern unless the user explicitly asks for a non-standard wiring.
- **Automations** close loops — they consume a read model and issue a command back. Use them for system-driven actions (email verifiers, retry timers, scheduled jobs) rather than UIs that don't represent an actual screen.
- **External events** sit above the actor lanes; only declare them for facts that genuinely originate outside the system (third-party webhooks, partner APIs). Don't use them as a substitute for ordinary commands or events you control.
- **Read models updated by ≥2 events** are rendered with duplicate stubs automatically; do NOT pre-author duplicates in the DSL.
- **Information completeness:** every field shown on a UI or read model must be traceable backward through events and commands to where it was first introduced. If you can't see a source, you're missing an element. Mention this gap to the user when you see it.
- **Cycles are okay.** Feedback loops like `paymentSucceeded → paymentsToProcess → paymentProcessor → ...` are first-class — the renderer handles back-edges.

## How to author

1. **Read the target file** (or note it doesn't exist yet). Inventory what's already declared so you don't duplicate ids or contradict an existing flow.
2. **Sketch the addition** in plain prose first — list each element you'll add, what kind it is, its label, its fields if any, and the edges connecting it to the rest of the model. Show this sketch to the user before editing the file. Get confirmation.
3. **Apply edits** with the `Edit` tool. Insert each new declaration in the section that matches its concept (e.g., a payment-related event goes near other payment elements). Preserve blank lines between conceptual sections.
4. **Add the flow edges** as bare `<id> --> <id>` lines next to the related declarations — the same way the existing files do it (slices are added later, by `add-slices`).
5. **Don't write `slice` blocks.** Slicing is a separate concern. After your edits, remind the user they can run `/mermaid-event-model:add-slices` to generate slices automatically.
6. **Verify** by re-reading the relevant chunk of the file and checking that every edge endpoint matches a declared element id (typos here will silently drop edges from the rendered diagram).
7. **Offer follow-ups:** propose `/mermaid-event-model:validate-completeness` to check for missing data sources, or offer to render the demo page if the user wants to see the result.

## What this skill does NOT do

- Generate `slice` declarations (use `/mermaid-event-model:add-slices`).
- Validate field traceability (use `/mermaid-event-model:validate-completeness`).
- Reset a file to the canonical demo (use `/mermaid-event-model:demo-event-model`).
- Modify files outside the target DSL file (no renderer or skill changes).
