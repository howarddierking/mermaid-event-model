---
name: validate-completeness
description: Analyze an Event Model DSL file for information completeness — verify that every field displayed in a UI or read model is traceable back through events and commands, with no gaps or assumed data.
argument-hint: [dsl-file-path]
---

# Validate Information Completeness

You are analyzing an Event Model DSL file to verify it satisfies the **information completeness principle**: every field in every view must be traceable to an event, and every event must be reachable through a command. The blueprint must account for all information — no implicit data, no hidden side effects, no assumed fields.

Reference: https://www.pradhan.is/blogs/event-modelling-best-practices

## Input

Read the DSL file at: `$ARGUMENTS`

If no argument is provided, default to `blueprint_dsl` in the project root.

## The Information Completeness Principle

Three rules must hold:

1. **Field traceability** — Every field displayed in a UI or present in a read model must originate from a domain event earlier in the flow. If a UI shows a field that no upstream event carries, the model is incomplete.

2. **Command-to-event connection** — Every command must produce at least one domain event. Every domain event must be reachable from a command (or from an external system event). No hidden side effects.

3. **No assumed information** — Data dependencies cannot be implicit. If a read model needs a field, an event must supply it. If a UI displays a field, a read model or event must carry it. Implementation cannot be left to "figure it out."

## How to Analyze

Work **backward** through the data flow — start from what the user sees (UIs) and trace each field back to its source.

### Step 1: Parse the DSL

Extract all elements with their types, fields, and edges. Build a dependency graph.

### Step 2: For each UI, trace fields backward

For every field in a UI element:

1. Find the upstream element(s) connected by edges (typically a read model, or directly a domain event).
2. Check whether that upstream element declares the field (same name and compatible type).
3. If the upstream is a **read model**, continue tracing: find the domain event(s) that feed into the read model and check that they carry the field.
4. If the upstream is a **domain event**, the field is sourced — but continue to verify that a command or prior event supplies the data needed to produce it.

### Step 3: For each read model, trace fields backward

For every field in a read model:

1. Find the domain event(s) connected by incoming edges.
2. Check whether at least one upstream event declares the field.
3. If no upstream event carries the field, it is a gap.

### Step 4: For each domain event, trace fields backward

For every field in a domain event:

1. Find the command(s) connected by incoming edges.
2. Check whether the command declares the field, OR whether the field is a system-generated value (e.g., `UUID` identifiers, `timestamp` fields like `registeredAt`, `bookedAt`). System-generated fields are fields that the system produces at event-creation time rather than receiving from user input.
3. If a field is neither in the command nor system-generated, it is a gap.

### Step 5: For each command, trace fields backward

For every field in a command:

1. Find the UI or automation connected by incoming edges.
2. Check whether the upstream element declares the field.
3. If the upstream is an automation, check whether the read model feeding the automation carries the field.

### Step 6: Check for orphans

- Commands with no incoming edge (no UI or automation triggers them)
- Domain events with no incoming command
- Read models with no incoming domain event
- UIs with no incoming read model AND no outgoing command (completely disconnected)

## Field matching rules

- Match fields by **name** (case-insensitive).
- Types should be compatible but don't need to be identical (e.g., `string` can carry a `UUID` value).
- A field like `guestId: UUID` in an event can originate from a command that also has `guestId: UUID`, even if the UI that triggered the command doesn't have it — as long as SOME upstream element in the chain provides it.
- System-generated fields (typically `*Id: UUID`, `*At: timestamp`, `*edAt: timestamp`) are allowed to appear in events without a command source. Flag them as "system-generated" rather than "missing."

## Output format

Present the results as a structured report:

### 1. Summary

State whether the model is **complete** or **has gaps**, with a count of issues found.

### 2. Field trace table

For each UI, list every field and its trace path:

```
UI: "Booking Screen" (booking_ui)
  roomId: UUID
    <- readModel "Room Availability" (avail) [roomId: UUID]     OK
    <- domainEvent "Room Added" (ra) [roomId: UUID]             OK
  roomType: string
    <- readModel "Room Availability" (avail) [roomType: string] OK
    <- domainEvent "Room Added" (ra) [roomType: string]         OK
  checkIn: date
    <- (no upstream read model carries this field)              GAP
```

### 3. Gaps list

Collect all gaps into a single list with:
- The element where the gap was found
- The missing field
- Where it was expected to come from
- A suggested fix (e.g., "add `checkIn: date` to the Room Availability read model" or "add a new event that carries this field")

### 4. Orphan elements

List any elements with no incoming or outgoing connections where expected.

## Important

- Do NOT modify the DSL file. This skill is analysis-only.
- If a field has multiple possible upstream paths (e.g., a read model fed by two events), it is sufficient for ANY one path to supply the field.
- Be precise about which specific edge/path has the gap — don't just say "field X is missing," say where in the chain it breaks.
