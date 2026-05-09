---
name: add-slices
description: Analyze an Event Model DSL file and (re)write its `slice` declarations from scratch based on the edges currently in the file. Strips any existing slices first so re-running cleanly replaces stale slices instead of accumulating them. Splits cleanly at automations so a single chain that crosses the read-side / command-side boundary becomes two slices, not one.
argument-hint: [dsl-file-path]
---

# Add Slices to an Event Model DSL

You are analyzing an Event Model DSL file and writing `slice` declarations that group its edges into vertical slices.

## Input

Read the DSL file at: `$ARGUMENTS`

If no argument is provided, default to `blueprint_dsl.md` in the project root.

**DSL files are markdown.** Each is a `.md` file whose DSL lives inside a fenced ```mermaid block whose first content line is `eventModel`. When you parse the file, look at the lines INSIDE that fence. When you write the new slice declarations, write them INSIDE the same fence. Don't add markdown content outside the fence and don't move the fence boundaries.

## Background: what is a slice?

In Event Modeling a **vertical slice** is a cohesive unit of behavior cutting across the horizontal timeline — one user-visible capability from trigger to outcome. Slices come in exactly two shapes:

- **Command slices** (write-side): a user or automation issues a command that produces a domain event.
  - Canonical: `(ui | automation) → command → domainEvent`
- **Read slices** (read-side): a domain event populates a read model that's consumed by a UI or automation.
  - Canonical: `domainEvent → readModel → (ui | automation)` (or any prefix/suffix of that chain)

A slice never mixes the two sides. The two are joined at the seams by elements that act as **boundary nodes**:

- A `domainEvent` is the OUTPUT of a command slice and the INPUT of a read slice. It appears in both.
- An `automation` is the TARGET of a read slice (`readModel → automation`) and the SOURCE of a command slice (`automation → command`). It appears in both.

## Algorithm

This skill is **idempotent**. On every run:

1. **Strip every existing `slice` declaration** from the DSL. Each existing `slice <id>["Label"]` block contributes its indented `-->` edges back to the global edge set as bare edges. After this step the file's mermaid block contains only element declarations and bare edges — the same shape it had before any prior run of this skill.

2. **Classify every edge** by its `(source-kind, target-kind)` pair into one of three buckets:

   | Source kind | Target kind | Bucket |
   |---|---|---|
   | `ui` | `command` | command-side |
   | `automation` | `command` | command-side |
   | `domainEvent` | `command` | command-side (event-triggered translator) |
   | `externalEvent` | `command` | command-side (external trigger) |
   | `command` | `domainEvent` | command-side |
   | `domainEvent` | `readModel` | read-side |
   | `externalEvent` | `readModel` | read-side |
   | `readModel` | `ui` | read-side |
   | `readModel` | `automation` | read-side |

   Edges that don't match any of those rows (e.g. an automation directly emitting an event without a command in between) are recorded separately and surfaced to the user as "unclassified edges that won't be sliced". Don't try to invent a slice for them.

3. **Group edges into slices by connected component, within each side, using the connector rules below.** Two edges are connected when they share a node that is a CONNECTOR. Edges that share a non-connector node are NOT connected — they go in different slices.

   | Node kind | Connector for command-side? | Connector for read-side? |
   |---|---|---|
   | `command` | yes | n/a (never appears) |
   | `readModel` | n/a | yes (unless fan-in — see step 4) |
   | `ui` | no | no |
   | `automation` | no | no |
   | `domainEvent` | no | no |
   | `externalEvent` | no | no |

   The intuition: a `command` packages its trigger and its produced event into one slice; a `readModel` packages its incoming event and its outgoing consumer(s) into one slice. Everything else is a boundary — it can appear in multiple slices but never glues them together.

4. **Read-side fan-in exception.** When a `readModel` has ≥2 incoming `domainEvent`/`externalEvent` edges, treat it as a NON-connector for grouping read-side edges. The renderer already draws this pattern with one stub per producing event, so splitting the slices matches the visual:

   - Emit one **per-event read slice** for each `event → readModel` edge (no consumer in this slice). Name as `feed_<event>` or `update_<readModel>_<event>`.
   - Emit one **view slice** containing the `readModel → consumer` edges (every UI/automation that consumes the read model goes in this slice). Name as `view_<readModel>`.

5. **Naming conventions.**

   - Command slices: name from the COMMAND in the chain (e.g. `book_room["Book Room"]`, `process_payment["Process Payment"]`).
   - Non-fan-in read slices: name from the read model and/or its consumer (e.g. `view_room_availability["View Room Availability"]`, `update_guest_roster["Update Guest Roster"]`).
   - Fan-in per-event slices: `feed_<event>` or `update_<readModel>_<event>`.
   - Fan-in view slice: `view_<readModel>`.
   - Use snake_case for ids and a human-readable string in the label.

6. **Boundary nodes appear in multiple slices.** This is correct, not a duplicate:

   - A `domainEvent` is the OUTPUT of its command slice and the INPUT of its read slice(s). It's named in both.
   - An `automation` that consumes a read model AND issues a command is the TARGET of one read slice (`readModel → automation`) and the SOURCE of one command slice (`automation → command → ...`). The read-side edge ends in the read slice; the command-side edge begins in the command slice; the automation node is named in both but the slices have completely disjoint edge lists.

7. **Generate the slice block in the file**, in the mermaid fence, replacing whatever slice content was stripped in step 1:

   - Use one tab for the `slice` declaration.
   - Use two tabs for the `-->` edges inside the slice.
   - Group slices in roughly the order their elements appear in the DSL so the diff stays readable.
   - Preserve a blank line between conceptual sections (auth slices, payment slices, etc.) when the parent file had them.

8. **Verify** every edge is accounted for: every edge that was bare in step 1 should now sit inside exactly one slice (or be on the unclassified list and explicitly skipped). If any edge is in zero slices or two slices, surface that as an error before writing.

## Worked example: an automation that closes a loop

Given these unsliced edges (a typical hotel-booking payment-processing fragment):

```
paymentRequested-->paymentsToProcess
paymentsToProcess-->paymentProcessor
paymentProcessor-->processPayment
processPayment-->paymentSucceeded
paymentSucceeded-->paymentsToProcess
```

…where `paymentsToProcess` is a `readModel`, `paymentProcessor` is an `automation`, `processPayment` is a `command`, and the others are `domainEvent`s — classify each edge:

| Edge | Bucket |
|---|---|
| `paymentRequested → paymentsToProcess` | read-side |
| `paymentsToProcess → paymentProcessor` | read-side |
| `paymentProcessor → processPayment` | command-side |
| `processPayment → paymentSucceeded` | command-side |
| `paymentSucceeded → paymentsToProcess` | read-side |

`paymentsToProcess` has 2 incoming domain-event edges (from `paymentRequested` and `paymentSucceeded`) → fan-in, so the read-side splits accordingly. `paymentProcessor` is a boundary automation: it sits at the END of one read-side group and the START of one command-side group, but its read-side and command-side edges go in different slices.

Result — four slices, three on the read side and one on the command side:

```
slice show_payments_to_process["Show Payments to Process"]
    paymentRequested-->paymentsToProcess

slice update_payment_status["Update Payment Status"]
    paymentSucceeded-->paymentsToProcess

slice trigger_payment_processing["Trigger Payment Processing"]
    paymentsToProcess-->paymentProcessor

slice process_payment["Process Payment"]
    paymentProcessor-->processPayment
    processPayment-->paymentSucceeded
```

Note specifically that `paymentProcessor` appears in BOTH the `trigger_payment_processing` slice (as the target of a read-side edge) AND the `process_payment` slice (as the source of a command-side edge). That's correct: an automation's read-side observation is one slice, the command it then issues is a different slice. They never get bundled.

## Output

1. Show the user your analysis: list the existing slices you'll strip, the edges you'll re-classify, and the proposed new slice set with each slice's edges. Flag any unclassified edges. Ask the user to confirm before modifying the file.
2. After confirmation, modify the DSL file to match — strip then rewrite, preserving everything outside the slice declarations.
3. Re-read the file and confirm the round trip: every bare edge from step 1 is in exactly one new slice, no slice references unknown ids, and all element/edge declarations outside the slices are unchanged.
