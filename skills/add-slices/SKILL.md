---
name: add-slices
description: Analyze an Event Model DSL file and (re)write its `slice` declarations from scratch based on the edges currently in the file. Strips any existing slices first so re-running cleanly replaces stale slices instead of accumulating them. Slices follow the four canonical Event Modeling patterns — including the Automation Pattern, which bundles `Event(s) → View → Automation → Command → Event(s)` into a single slice rather than splitting at the automation.
argument-hint: [dsl-file-path]
---

# Add Slices to an Event Model DSL

You are analyzing an Event Model DSL file and writing `slice` declarations that group its edges into vertical slices, following the four canonical Event Modeling patterns.

## Input

Read the DSL file at: `$ARGUMENTS`

If no argument is provided, default to `blueprint_dsl.md` in the project root.

**DSL files are markdown.** Each is a `.md` file whose DSL lives inside a fenced ```mermaid block whose first content line is `eventModel`. When you parse the file, look at the lines INSIDE that fence. When you write the new slice declarations, write them INSIDE the same fence. Don't add markdown content outside the fence and don't move the fence boundaries.

## Background: the four canonical patterns

In Event Modeling a **vertical slice** is a cohesive unit of behavior cutting across the horizontal timeline — one user-visible capability from trigger to outcome. Per [eventmodeling.org's cheat sheet](https://eventmodeling.org/posts/event-modeling-cheatsheet/), a slice is the smallest possible unit of work that can be handed to a developer, and there are exactly four canonical patterns:

1. **Command Pattern (state change):** `Trigger → Command → Event(s)`. Trigger is a `ui` (user action) or another non-automation source.
2. **View Pattern (state query):** `Event(s) → View`, optionally extended to a consuming `ui`. The view is our `readModel`.
3. **Automation Pattern (internal processing):** `Event(s) → View → Automation → Command → Event(s)`. The automation observes a view (typically a "todo list" read model) and triggers commands per row. **The whole chain is ONE slice.**
4. **Translation Pattern (inter-system):** Same shape as the Automation Pattern but moving knowledge between systems. Treated identically to Pattern 3 here.

The canonical decision worth highlighting: an automation's read-side observation **and** its command emission belong to the **same slice**. The automation is not a slice boundary — it's the connecting tissue that makes the whole pattern one cohesive unit of work.

## Algorithm

This skill is **idempotent**. On every run:

1. **Strip every existing `slice` declaration** from the DSL. Each existing block contributes its indented `-->` edges back to the global edge set as bare edges. After this step the mermaid block contains only element declarations and bare edges.

2. **Classify every edge** by its `(source-kind, target-kind)` pair:

   | Source kind | Target kind | Bucket |
   |---|---|---|
   | `ui` | `command` | command-side |
   | `automation` | `command` | command-side |
   | `domainEvent` | `command` | command-side (event-triggered translator command) |
   | `externalEvent` | `command` | command-side (external trigger) |
   | `command` | `domainEvent` | command-side |
   | `domainEvent` | `readModel` | read-side |
   | `externalEvent` | `readModel` | read-side |
   | `readModel` | `ui` | read-side |
   | `readModel` | `automation` | read-side (input to an Automation Pattern) |

   Edges that don't match any row are unclassified — surface them to the user but don't try to slice them.

3. **Identify Automation Patterns first.** For every `automation` that has BOTH at least one incoming `readModel → automation` edge AND at least one outgoing `automation → command` edge, claim a single Automation Pattern slice containing:

   - Every `readModel → automation` edge for that automation.
   - Every `event → readModel` edge feeding the input read model(s) — the canonical pattern is `Event(s) → View → ...`, so the projecting events are part of this slice.
   - Every `automation → command` edge from this automation.
   - Every `command → domainEvent` edge produced by those commands.

   Claim these edges off the unclassified pool — they will not be considered again in steps 4 and 5. Name the slice after the automation (e.g. `payment_processor["Payment Processor"]`, `email_verifier["Email Verifier"]`).

4. **For remaining read-side edges** (those not claimed by an Automation Pattern), build slices following Pattern 2 (View). Two read-side edges are connected when they share a `readModel` node. The unit of grouping is the connected component, with one practical exception:

   - **Fan-in into a view-only read model** (a read model with ≥2 incoming `event → readModel` edges that's NOT an automation's input): split into per-event slices for visual clarity. Emit one slice per `event → readModel` edge (named `feed_<event>` or `update_<readModel>_<event>`) plus one `view_<readModel>` slice containing the `readModel → consumer` edges. This is a renderer-friendly extension; canonical Pattern 2 would bundle them, but our renderer would draw a diagram-spanning bar.
   - All other view patterns (single event, or single consumer) become one slice each, named after the readModel or its consumer.

5. **For remaining command-side edges** (those not claimed by an Automation Pattern), build Pattern 1 (Command) slices. Two command-side edges are connected when they share a `command` node. Each connected component is one command slice, named after the command.

6. **Naming conventions.**

   - Automation Pattern slices: name from the automation (e.g. `payment_processor["Process Payment"]`, `delivery_tracker["Track Delivery"]`).
   - Command slices: name from the command (e.g. `book_room["Book Room"]`).
   - View slices: name from the read model and/or consumer (e.g. `view_room_availability`, `update_guest_roster`).
   - Fan-in per-event slices: `feed_<event>` or `update_<readModel>_<event>`.
   - Fan-in view slice: `view_<readModel>`.
   - Use snake_case for ids and a human-readable string in the label.

7. **Boundary nodes still appear in multiple slices.** A `domainEvent` is the OUTPUT of one slice (Pattern 1 or Pattern 3) and may be the INPUT of another (Pattern 2 or Pattern 3) — it's named in both. `automation` and `readModel` only appear in one slice each in the canonical patterns; the only way they show up twice is when the same readModel feeds an Automation Pattern slice AND a separate view-only consumer.

8. **Generate the slice block in the file**, in the mermaid fence, replacing whatever slice content was stripped in step 1:

   - One tab for the `slice` declaration.
   - Two tabs for the `-->` edges inside the slice.
   - Group slices in roughly the order their elements appear in the DSL.
   - Preserve a blank line between conceptual sections when the parent file had them.

9. **Verify** every edge is accounted for: every edge that was bare in step 1 should now sit inside exactly one slice (or be on the unclassified list and explicitly skipped). If any edge is in zero slices or two slices, surface that as an error before writing.

## Worked example: an automation that closes a loop

Given these unsliced edges (a hotel-booking payment-processing fragment):

```
paymentRequested-->paymentsToProcess
paymentsToProcess-->paymentProcessor
paymentProcessor-->processPayment
processPayment-->paymentSucceeded
paymentSucceeded-->paymentsToProcess
paymentSucceeded-->salesReport
salesReport-->sales_ui
```

…where `paymentsToProcess` and `salesReport` are read models, `paymentProcessor` is an automation, `processPayment` is a command, the rest are events, and `sales_ui` is a UI.

Step 3 finds `paymentProcessor` has both a `readModel → automation` edge (`paymentsToProcess → paymentProcessor`) AND an `automation → command` edge (`paymentProcessor → processPayment`). Claim the canonical Automation Pattern slice — including the events feeding `paymentsToProcess` and the events produced by `processPayment`:

```
slice payment_processor["Process Payment"]
    paymentRequested-->paymentsToProcess
    paymentSucceeded-->paymentsToProcess
    paymentsToProcess-->paymentProcessor
    paymentProcessor-->processPayment
    processPayment-->paymentSucceeded
```

This is one slice that closes the loop — exactly Pattern 3's `Event(s) → View → Automation → Command → Event(s)` shape, including the back-edge that feeds new events into the same view. The automation node is part of this single slice, not split between two.

`paymentSucceeded → salesReport` and `salesReport → sales_ui` are NOT claimed by the Automation Pattern (they involve a different read model with no automation consumer), so they form a Pattern 2 view slice:

```
slice view_sales_report["View Sales Report"]
    paymentSucceeded-->salesReport
    salesReport-->sales_ui
```

Total: 2 slices for 7 edges. The boundary `paymentSucceeded` event appears in both — output of the automation slice, input to the view slice.

## Output

1. Show the user your analysis: list the existing slices you'll strip, the edges you'll re-classify, and the proposed new slice set with each slice's edges. Flag any unclassified edges. Ask the user to confirm before modifying the file.
2. After confirmation, modify the DSL file to match — strip then rewrite, preserving everything outside the slice declarations.
3. Re-read the file and confirm the round trip: every bare edge from step 1 is in exactly one new slice, no slice references unknown ids, and all element/edge declarations outside the slices are unchanged.
