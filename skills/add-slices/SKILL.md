---
name: add-slices
description: Analyze an Event Model DSL file and (re)write its `slice` declarations from scratch based on the edges currently in the file. Strips any existing slices first so re-running cleanly replaces stale slices instead of accumulating them. Every slice is classified against the four canonical Event Modeling patterns — Command, View, Automation, and Translation — with `externalEvent` as the sole discriminator between Automation and Translation, since the two are structurally identical. Slices that match no canonical shape are flagged rather than forced into a bucket, and the run also reports model defects the classification exposes: read sides that mix two systems, and orphan events that should have been declared external. The pattern is reported, never written into the DSL.
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

1. **Command Pattern (state change):** `Trigger → Command → Event(s)`. Describes a state change "from the start (what is the trigger?) to the end (what is the state change?)." The trigger is a `ui` — a **user** acting on the system.
2. **View Pattern (state query):** `Event(s) → View`, optionally extended to a consuming `ui`. The view is our `readModel`.
3. **Automation Pattern (internal processing):** `Event(s) → View → Automated Trigger → Command → Event(s)`. Use it "whenever the system should do something automatically." The automation monitors a view — "a simple todo list" — and triggers commands per row. It holds **no business logic**: "the automation works the same way as a user would use the system."
4. **Translation Pattern (inter-system):** **Structurally identical to Pattern 3.** What separates them is not shape but *system membership*: Translation "is used for transferring knowledge from one system into another system," under the restriction that "on the read side of the pattern you can only read events from one system. The write side has no limitation."

Two consequences drive the algorithm:

- **An automation's read-side observation and its command emission belong to the same slice.** The automation is not a slice boundary — it's the connecting tissue that makes the whole pattern one cohesive unit of work.
- **Automation and Translation cannot be told apart structurally.** The only construct in this DSL that marks a system boundary is `externalEvent`, so it is the sole discriminator: a slice with the Automation shape whose read side is fed by an `externalEvent` is a **Translation**; one whose read side is entirely `domainEvent`s is an **Automation**.

### The abbreviated variant

Real models frequently omit the View and the Automated Trigger, wiring an event straight into a command: `Event(s) → Command → Event(s)`. Classify these as the pattern they would be with the middle restored — **Translation** when the source is an `externalEvent`, **Automation** when it is a `domainEvent` — and tag them `[abbreviated]` in the report so the deviation stays visible.

The elided View and Trigger carry no code of their own, so code generation is unaffected. What matters is that such a slice is **not** mistaken for a Command Pattern, whose trigger is a *user*. That distinction is the whole point of classifying: a translation and a user-initiated command produce completely different blueprints — an inbound listener versus an API endpoint.

### Outbound translation is not currently expressible

`externalEvent` marks the source side only. A slice that translates our events *outward* into another system is structurally indistinguishable from an Automation and will be classified as one. If a slice's command name implies an outbound call, say so in the report — but do not guess, and do not invent a marker for it.

### The pattern is reported, never written into the DSL

The `slice` grammar has no slot for a pattern and must not grow one. A hand-authored pattern tag would let a model author assert something the edges contradict. The classification is a **derived fact** — recomputed from the edges whenever it is needed, and recorded downstream (in slice spec files) rather than in the model.

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

3. **Identify Automation and Translation Patterns first.** For every `automation` that has BOTH at least one incoming `readModel → automation` edge AND at least one outgoing `automation → command` edge, claim a single slice containing:

   - Every `readModel → automation` edge for that automation.
   - Every `event → readModel` edge feeding the input read model(s) — the canonical pattern is `Event(s) → View → ...`, so the projecting events are part of this slice.
   - Every `automation → command` edge from this automation.
   - Every `command → domainEvent` edge produced by those commands.

   Then **classify it by its read side**: **Translation** if any event feeding it is an `externalEvent`, **Automation** if they are all `domainEvent`s. (If it is fed by both, that is a defect — see step 6.)

   Claim these edges off the unclassified pool — they will not be considered again in steps 4 and 5. Name the slice after the automation (e.g. `payment_processor["Payment Processor"]`, `email_verifier["Email Verifier"]`).

4. **For remaining read-side edges** (those not claimed by an Automation Pattern), build slices following Pattern 2 (View). Two read-side edges are connected when they share a `readModel` node. The unit of grouping is the connected component, with one practical exception:

   - **Fan-in into a view-only read model** (a read model with ≥2 incoming `event → readModel` edges that's NOT an automation's input): split into per-event slices for visual clarity. Emit one slice per `event → readModel` edge (named `feed_<event>` or `update_<readModel>_<event>`) plus one `view_<readModel>` slice containing the `readModel → consumer` edges. This is a renderer-friendly extension; canonical Pattern 2 would bundle them, but our renderer would draw a diagram-spanning bar.
   - All other view patterns (single event, or single consumer) become one slice each, named after the readModel or its consumer.

5. **For remaining command-side edges** (those not claimed in step 3), group them into slices — two command-side edges are connected when they share a `command` node, and each connected component is one slice. Then **classify each by its trigger**, the kind of the node on the inbound edge into the command:

   | Trigger kind | Pattern |
   |---|---|
   | `ui` | **Command** — a user acting on the system |
   | `externalEvent` | **Translation** `[abbreviated]` — knowledge arriving from another system |
   | `domainEvent` | **Automation** `[abbreviated]` — the system reacting to itself |
   | `automation` | Should have been claimed in step 3. Reaching here means the automation has no `readModel →` input, so it is not monitoring a view — flag it. |

   Do **not** default everything here to Pattern 1. Trigger kind is what separates a translation from a user-initiated command, and they generate completely different code.

   Two shapes to flag rather than classify:

   - A component whose command has **no inbound edge** has no trigger at all. Report it; do not assume one.
   - A component whose command has inbound edges of **more than one trigger kind** is a fused slice — see step 6.

6. **Validate the classification.** The findings below are defects in the *model*, not failures of classification. Surface each one to the user with the suggested fix, and do not paper over it:

   - **Mixed read side.** A slice whose read side draws from both `externalEvent`s and `domainEvent`s is reading events from two systems, which Pattern 4 explicitly forbids: "on the read side of the pattern you can only read events from one system." This is almost always two patterns fused into one slice — an Automation and a Translation sharing a single command. The fix is to split them, which normally means giving each its own command.
   - **Orphan domain events.** A `domainEvent` that no `command → domainEvent` edge in the model produces has no in-model producer, which means it originated elsewhere. It should almost certainly be declared an `externalEvent` instead. Report the event, the slice consuming it, and the suggested change — this single re-typing often converts a misclassified slice into a correct Translation.
   - **Untriggered commands**, from step 5.

7. **Naming conventions.**

   - Automation and Translation Pattern slices: name from the automation (e.g. `payment_processor["Process Payment"]`, `delivery_tracker["Track Delivery"]`).
   - Abbreviated Translation slices (no automation node): name from the command (e.g. `gateway_confirmation["Gateway Confirmation"]`).
   - Command slices: name from the command (e.g. `book_room["Book Room"]`).
   - View slices: name from the read model and/or consumer (e.g. `view_room_availability`, `update_guest_roster`).
   - Fan-in per-event slices: `feed_<event>` or `update_<readModel>_<event>`.
   - Fan-in view slice: `view_<readModel>`.
   - Use snake_case for ids and a human-readable string in the label.

8. **Boundary nodes still appear in multiple slices.** A `domainEvent` is the OUTPUT of one slice (Pattern 1 or Pattern 3) and may be the INPUT of another (Pattern 2 or Pattern 3) — it's named in both. `automation` and `readModel` only appear in one slice each in the canonical patterns; the only way they show up twice is when the same readModel feeds an Automation Pattern slice AND a separate view-only consumer.

9. **Generate the slice block in the file**, in the mermaid fence, replacing whatever slice content was stripped in step 1:

   - One tab for the `slice` declaration.
   - Two tabs for the `-->` edges inside the slice.
   - Group slices in roughly the order their elements appear in the DSL.
   - Preserve a blank line between conceptual sections when the parent file had them.

10. **Verify** every edge is accounted for: every edge that was bare in step 1 should now sit inside exactly one slice (or be on the unclassified list and explicitly skipped). If any edge is in zero slices or two slices, surface that as an error before writing.

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

## Worked example: telling Translation from Automation

Both worked cases below are real defects found in `blueprint_dsl_dcb.md`, and both were classification failures before step 6 existed.

**Case 1 — a mixed read side.** The payment slice originally read:

```
paymentRequested-->paymentsToProcess
paymentSucceeded-->paymentsToProcess
paymentsToProcess-->paymentProcessor
paymentProcessor-->processPayment
gatewayConfirmed-->processPayment      <-- externalEvent
processPayment-->paymentSucceeded
```

Step 3 claims it as an Automation, but its read side draws on `paymentRequested`/`paymentSucceeded` (ours, through the view) *and* `gatewayConfirmed` (the gateway's, straight into the command). That is the step 6 mixed-read-side violation: Pattern 4 permits reading from only one system. The slice is really an Automation and a Translation fused through a shared command, and the fix is to give each its own — the automation submits the payment, and a separate translation ingests the gateway's confirmation.

**Case 2 — an orphan event hiding a Translation.** This slice classified as a Command Pattern:

```
positionUpdated-->hotelProximityTranslator
hotelProximityTranslator-->guestLeft
```

Nothing in the model produces `positionUpdated` — no `command → positionUpdated` edge exists anywhere. An event with no in-model producer came from another system, so it should have been declared `externalEvent`, not `domainEvent`. Re-typing that one element converts the slice from a mis-filed Command into an abbreviated Translation, and moves the node into the synthesized `External` lane where it visually belongs.

The lesson both cases teach: **when a slice will not classify, suspect the model before the rules.** The classifier's job is to make the model's claims checkable, and a slice that resists classification is usually reporting a real defect.

## Output

1. Show the user your analysis: list the existing slices you'll strip, the edges you'll re-classify, and the proposed new slice set with each slice's edges **and its classified pattern**, tagged `[abbreviated]` where that applies. Flag any unclassified edges, plus every validation finding from step 6 with its suggested fix. Ask the user to confirm before modifying the file.
2. After confirmation, modify the DSL file to match — strip then rewrite, preserving everything outside the slice declarations.
3. Re-read the file and confirm the round trip: every bare edge from step 1 is in exactly one new slice, no slice references unknown ids, and all element/edge declarations outside the slices are unchanged.
