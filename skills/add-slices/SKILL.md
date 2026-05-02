---
name: add-slices
description: Analyze an Event Model DSL file and automatically add slice declarations based on data flow direction. Slices group contiguous chains of edges that flow together through the canonical event modeling pattern.
argument-hint: [dsl-file-path]
---

# Add Slices to an Event Model DSL

You are analyzing an Event Model DSL file and adding `slice` declarations that group related elements into vertical slices based on data flow.

## Input

Read the DSL file at: `$ARGUMENTS`

If no argument is provided, default to `blueprint_dsl.md` in the project root.

**DSL files are markdown.** Each one is a `.md` file whose DSL lives inside a fenced ```mermaid block whose first content line is `eventModel`. When you parse the file for slices, look at the lines INSIDE that fence. When you write `slice` declarations back into the file, insert them INSIDE the same fence — preserving the existing tab indentation. Don't add any markdown content outside the fence and don't move the fence boundaries.

## Background: What is a slice?

In Event Modeling, a **vertical slice** is a cohesive unit of behavior that cuts across the horizontal timeline. Each slice represents one user-visible capability — the full path from trigger to outcome.

There are two kinds of slices, determined by the **direction of data flow**:

### Command slices (left-to-right / top-to-bottom)
A user (or automation) issues a command that produces a domain event. The canonical pattern is:

```
ui → command → domainEvent
```

or

```
automation → command → domainEvent
```

These represent **write-side** behavior: something happens that changes state.

### Read/View slices (right-to-left / bottom-to-top)
A domain event populates a read model, which is then consumed by a UI or automation. The canonical pattern is:

```
domainEvent → readModel → ui
```

or

```
domainEvent → readModel → automation
```

These represent **read-side** behavior: state is projected and presented.

## How to identify slices

1. **Parse the DSL** to extract all elements (with their types) and edges.
2. **Skip edges that are already inside an existing `slice` block.** Only analyze unsliced edges.
3. **Build chains** by following connected edges. A chain continues as long as:
   - The edges flow in a consistent direction through the canonical pattern (`ui → command → domainEvent → readModel → ui/automation`)
   - The direction doesn't reverse mid-chain (a command slice doesn't include the downstream read model consumption, and a read slice doesn't include the upstream command that produced the event)
4. **Determine slice boundaries** by recognizing where direction changes:
   - A `domainEvent → readModel` edge starts a NEW read slice (even if the event was the tail of a command slice)
   - A `readModel → ui` or `readModel → automation` edge continues a read slice
   - A `ui → command` or `automation → command` edge starts a NEW command slice
   - A `command → domainEvent` edge continues a command slice
5. **Name each slice** with a descriptive label derived from the primary action or outcome. Use snake_case for the id and a human-readable string in the label.

## Slice boundary rules

- A single domain event may appear in BOTH a command slice (as the output) and a read slice (as the input). This is correct — the event is the hinge point between write and read sides.
- Read models that feed into a UI or automation usually include that consumer in the slice. A read slice of `event → readModel` followed by `readModel → ui` is a single connected flow and should be one slice — EXCEPT in the fan-in case below.
- **Fan-in read models (≥2 incoming domain/external event edges):** the renderer draws this pattern with one stub per producing event. Bundling each event chain through to the consumer would produce N overlapping slices that span from each event all the way to the consumer. Instead, split it:
  - One **per-event read slice** for each `event → readModel` edge (no consumer in this slice). Name these like `feed_<event>` or `update_<readmodel>_<event>`.
  - One **view slice** containing the single `readModel → ui/automation` edge. Name this like `view_<readmodel>`.
  This produces N+1 slices total instead of N wide ones, and each one is compact.
- Automation loops (e.g., `readModel → automation → command → event → readModel`) should be split into a read slice (readModel → automation) and a command slice (automation → command → event).
- If an edge connects two elements across what would be different slices (e.g., a domain event feeding a read model that's part of a different flow), that edge forms its own read slice or extends an existing one.

## Example

Given these unsliced edges:

```
avail-->booking_ui
booking_ui-->bookRoom
bookRoom-->booked
```

This produces TWO slices:

1. **Read slice**: `avail → booking_ui` (read model consumed by UI)
2. **Command slice**: `booking_ui → bookRoom → booked` (UI triggers command producing event)

```
slice show_availability["Show Availability"]
    avail-->booking_ui

slice book_room["Book Room"]
    booking_ui-->bookRoom
    bookRoom-->booked
```

## Output

1. First, present your analysis: list each group of edges you identified, the flow direction, and the proposed slice name. Ask the user to confirm before modifying the file.
2. After confirmation, modify the DSL file to:
   - Replace the bare edges with `slice` blocks
   - Use one tab of indentation for the slice declaration (matching sibling elements)
   - Use two tabs of indentation for edges inside the slice
   - Preserve blank lines between sections for readability
   - Keep any existing slices unchanged
3. Verify the result parses correctly by checking that every edge references a declared element id.
