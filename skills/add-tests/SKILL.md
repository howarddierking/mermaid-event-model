---
name: add-tests
description: Author `sliceTests` Given/When/Then specifications for a slice and append them to that slice's spec file. The target slice can be named or inferred from the test's own action element (its command, or read model for a view test). You describe the test in natural language and pick (or accept an inferred) flow type; the skill grounds every element, outcome, and field against the slice's Model section. It includes only the subset of fields the test's language actually exercises, and — like validate-completeness — refuses to invent data: any attribute you reference that no element in the slice carries is raised back to you before anything is written. Existing tests, the Description, and the Model section always round-trip unchanged.
argument-hint: [slice] [test intent...]
---

# Add Tests to a Slice

You are authoring one or more `sliceTests` test declarations for a single
vertical slice and appending them to the `## Tests` section of that slice's
spec file (`<model>-slices/<slug>.md`). Tests are driven by a natural-language
statement of intent — "books a room for a registered guest", "rejects a
duplicate room number", "reports total revenue across two payments" — from
which you infer the flow type, the participating elements, and the *subset of
fields* the test actually exercises. Every element name, label, and field must
be grounded in the slice's `## Model` snippet; you never invent data.

## Input

`$ARGUMENTS` may carry, in any order and any partially:

- A **slice selector** — a slice id or (slugified) title identifying which
  slice to add tests to.
- A **test intent** — a natural-language description of the behavior to test.

Both are optional. Resolve what's missing interactively (below). The user may
also ask for several tests at once; treat each distinct behavior as its own
`test[...]` declaration.

## Prerequisites: this skill writes into spec files

Tests live in the `## Tests` section of a slice spec file produced by
`spec-slices`. This skill does **not** create spec files or parse the raw
`eventModel` DSL directly — it operates on the already-stamped spec, whose
`## Model` section is the ground-truth element inventory for the slice.

1. **Locate the model.** Resolve the DSL file the same way the sibling skills
   do: an explicit path in `$ARGUMENTS`, else the most recently referenced DSL
   file in the conversation, else `blueprint_dsl.md` in the project root. Its
   spec directory is the sibling `<model>-slices/`.

2. **If the spec directory or the target slice's spec file does not exist**,
   stop and tell the user to run `spec-slices` first (offer to run it for
   them). Do not fabricate a spec file — `spec-slices` owns the Model and
   Description sections and must stamp them from the live model.

## Selecting the slice

The target slice can be given explicitly or **inferred from the test itself** —
you rarely need to name it.

1. **Explicit selector.** If a slice selector was given, resolve it to a spec
   file: slugify the provided id/title (lowercase, runs of non-alphanumerics →
   single `-`, trim) and match it against the filenames in `<model>-slices/`,
   or match the `<!-- slice id: <id> -->` comment inside each file. If it's
   ambiguous or has no match, list the available slices and ask.

2. **Infer from the test's action element.** If no selector was given, don't ask
   yet — the test's own Given/When/Then usually names its slice. Build a
   cross-slice index by reading the `## Model` section of every spec file in
   `<model>-slices/` and recording, per slice, the labels of its elements by
   kind. Then key off the **action element** the intent describes:

   - For command-driven flows (state change, rejection, external input/output):
     the **command** under test. A command belongs to exactly one slice, so its
     label pins the slice down uniquely.
   - For a state-view flow: the **read model** being projected in `then`. A
     view-only read model belongs to one view slice.

   Match that action element's label (fuzzily against the intent's wording)
   against the index. **Do not** match on Given/Then `domainEvent`s alone — a
   domain event is a boundary node that is the output of one slice and the input
   of another, so it appears in multiple slices and can't disambiguate on its
   own. Use the events only to corroborate a command/read-model match.

   - **Exactly one slice matches** → use it. State which slice you inferred and
     the element that identified it, so the user can catch a mis-target before
     anything is written.
   - **Several slices match** (e.g. a read model that both feeds an automation
     slice and a separate view consumer) → present just those candidates and
     ask.
   - **No slice matches** → the action the intent describes isn't owned by any
     slice in this model. Raise it: name the command/read model you looked for,
     and either ask the user to pick from the full slice list or point them at
     `event-model` / `add-slices` if the behavior isn't modeled yet.

3. **Fall back to asking.** Only when inference is ambiguous or empty (or the
   intent itself is still unknown) list every spec file (title + id) and ask.

## Parse the slice's Model section

Read the chosen spec file and parse the `eventModel` snippet inside its
`## Model` fence. Build the slice's element inventory — for each element:

- **kind**: `ui`, `command`, `domainEvent`, `externalEvent`, `readModel`, or
  `automation`.
- **label**: the `["..."]` text (this is what a `sliceTests` item carries).
- **lane qualifier** if any (the actor/aggregate after `:`).
- **fields**: the brace-delimited `{ name: type ... }` data section, verbatim.
- the slice's **edges**, so you know the flow direction.

This inventory is the *only* source of truth for element labels and field
names in the generated tests. `command reads [...]` clauses are a DCB hydration
directive — never a flow edge — so they do not participate here; ignore them
when reasoning about given/when/then structure.

## The five flow types

Each maps to a canonical `sliceTests` shape (see `blueprint_sliceTests.md`).
The item **kinds and labels** come from the slice's Model; only the
given/when/then *arrangement* is fixed by the flow type.

| Flow type | given | when | then |
| --- | --- | --- | --- |
| **State change** | prior `domainEvent`(s) that set up the scenario | the `command` under test | emitted `domainEvent`(s) |
| **Rejection** | prior `domainEvent`(s) | the `command` under test | `error["<message>"]` |
| **State view** | the `domainEvent`(s) that feed the view | *(omitted)* | the `readModel` projection |
| **External input** | prior `externalEvent`/`domainEvent`(s) | the translating `command` | emitted `domainEvent`(s) |
| **External output** | the `readModel` holding what to emit | the `command` under test | emitted `domainEvent`(s) |

## Algorithm

### 1. Infer the flow type, then let the user override

If you inferred the slice from the test's action element (above), you already
have a flow type in hand — carry it forward and just confirm it. Otherwise
propose a default from the slice's model shape *and* the intent's wording:

- Slice has a `command → domainEvent` edge and the intent describes a **success**
  → **State change**.
- Same shape but the intent describes a **rejection / invalid / "should fail"**
  outcome → **Rejection**.
- Slice is `domainEvent(s) → readModel` with no command (a View slice) → **State view**.
- Slice translates an `externalEvent`/event into domain events via a command →
  **External input**.
- Slice emits domain events *from* a `readModel` via a command (outbound
  translation) → **External output**.

State the inferred type and why. If the user passed an explicit flow type in
`$ARGUMENTS`, honor it without asking. Otherwise offer the inference as the
default and let them override — and note that a slice can legitimately warrant
several tests of different types (e.g., a state-change *and* its rejection).

### 2. Ground every reference against the model — raise gaps, never invent

This is the core discipline of the skill, mirroring
`validate-completeness`'s field-traceability rule.

Read the intent and identify every **attribute** it references — anything the
test claims to set up, act on, or assert (e.g., "verify the booking
**timestamp**", "for a **registered** guest", "when the **room number** is
already taken").

For each referenced attribute:

1. Find the slice element it belongs to (by role: a given precondition, the
   command payload, or a then outcome).
2. Check that some element of the appropriate kind in the slice's Model
   declares a matching field — **match by name, case-insensitive**; types
   should be compatible but need not be identical.
3. **If the attribute exists in the model**, it is grounded — include it (per
   the subset rules below).
4. **If no element in the slice carries the attribute**, STOP before writing.
   Report it exactly as a completeness gap would: name the attribute, the
   element/role where the test expected it, and the fields that element *does*
   carry. Ask the user how to resolve — correct the intent, drop that
   assertion, or extend the model first (via the `event-model` skill, then
   re-run `spec-slices`). Do not silently add the field and do not guess a
   plausible name.

Do the same for element **labels**: every `given`/`when`/`then` item must
correspond to a real element in the slice. If the intent implies an event,
command, or read model the slice doesn't contain, that's a gap — raise it.

### 3. Select the field subset from the intent's language

Most tests verify only a *subsection* of an element's data, so do **not** copy
whole data sections by default. Instead:

- Include the fields the intent's language actually exercises — the attributes
  identified and grounded in step 2 — on the elements where they belong.
- Always include the minimal **identifying/key fields** needed to make the
  scenario coherent (typically the `*Id: UUID` keys that tie a given event to
  the command and outcome), even if the prose didn't name them explicitly —
  these come from the model, so they're grounded.
- Omit fields the test doesn't speak to. A test about the booking timestamp
  need not restate `roomType` or `capacity`.
- When the intent is vague about data, keep it minimal: labels plus key fields.
  Never emit more than the model supports.

Copy each included field's declared **type** from the model verbatim
(`bookedAt: timestamp`, not a guessed type).

### 4. Author the rejection message (verbatim)

For a **Rejection** test, the `error["<message>"]` string is read **verbatim by
downstream code generation** — each `error[...]` maps to throwing the target
framework's domain exception with the exact string. So:

- Prefer a message the slice's `## Description` already states as the rejection
  reason; otherwise derive a precise message from the intent.
- Surface the chosen message to the user and confirm it, since it is a contract
  the code generator will reproduce character-for-character.

### 5. Render the test block

Emit each test as a `test["<Title>"]` declaration in `sliceTests` DSL,
tab-indented to match the fence body in the spec file (`test` at one tab,
section keywords `given`/`when`/`then` at two tabs, items at three, fields at
four with a closing `}` at three). Give each test a short, behavior-describing
title derived from the intent. Omit the `when` section for State-view tests.
Include a data section on an item only when step 3 selected fields for it.

### 6. Append into `## Tests`, preserving everything else

1. Locate the `## Tests` heading and its ` ```mermaid ` fence containing
   `sliceTests`. Its content runs from the heading to the next `## ` heading or
   end-of-file.
2. **If the fence still holds only the untouched template skeleton** (the
   single `test["Describe what this test verifies"]` with its comment lines and
   no real items), replace that skeleton with the new test(s).
3. **Otherwise append** the new `test[...]` block(s) after the last existing
   test, inside the same fence, separated by one blank line. Never modify,
   reorder, or delete existing tests.
4. If the spec has no `## Tests` section at all (an older stamp), add one with a
   `sliceTests` fence containing the new tests.
5. Leave the `## Model` and `## Description` sections — and any other sections —
   byte-for-byte unchanged. Write the file back.

### 7. Report

Tell the user: the slice and spec file, the flow type used (and whether it was
inferred or chosen), each test added with its title, and — if any — the
traceability gaps you raised and how they were resolved. If gaps were left
unresolved, say plainly that no tests were written for those.

## Worked example

Spec file `blueprint_dsl_dcb-slices/book-room.md`, whose Model declares a
`command bookRoom["Book Room"] { guestId: UUID, roomId: UUID, checkIn: date,
checkOut: date }`, given events `Registered { guestId: UUID, name, email }` and
`Room Added { roomId: UUID, roomNumber, roomType }`, and an emitted
`Room Booked { bookingId: UUID, guestId: UUID, roomId: UUID, bookedAt:
timestamp }`.

Intent: *"books a room for a registered guest and stamps the booking time."*

- Inferred flow type: **State change** (`command → domainEvent`, success wording).
- Grounded attributes: "registered guest" → `guestId` (on `Registered` and the
  command); "booking time" → `bookedAt` on `Room Booked` — both present in the
  model. ✓ No gaps.
- Field subset: keep `guestId`/`roomId` keys to tie the scenario together and
  `bookedAt` because the intent asks for it; omit `name`, `email`, `roomNumber`,
  `roomType`, `checkIn`, `checkOut` — the test doesn't speak to them.

Appended:

```
	test["Books a room for a registered guest and stamps the booking time"]
		given
			domainEvent["Registered"] {
				guestId: UUID
			}
			domainEvent["Room Added"] {
				roomId: UUID
			}
		when
			command["Book Room"] {
				guestId: UUID
				roomId: UUID
			}
		then
			domainEvent["Room Booked"] {
				bookingId: UUID
				guestId: UUID
				roomId: UUID
				bookedAt: timestamp
			}
```

Counter-example — a gap that must be raised: intent *"rejects the booking when
the guest's **loyaltyTier** is expired."* No element in the `book_room` slice
carries `loyaltyTier`. Stop and report: `loyaltyTier` is not present on any
given event, the command, or any outcome in this slice (the command carries
`guestId`, `roomId`, `checkIn`, `checkOut`). Ask whether to correct the intent,
drop the assertion, or extend the model first. Write nothing until resolved.

## Notes

- **Read-only with respect to the DSL and to Model/Description.** This skill
  only appends to (or fills) the `## Tests` section of the chosen spec file.
- **Idempotent-friendly, not idempotent.** Re-running appends more tests; it
  does not dedupe. If the same behavior is described twice, the user gets two
  tests — mention it rather than silently skipping.
- **One slice per run's target**, but multiple tests are fine. If the intent
  spans several slices, handle one slice and tell the user which others their
  description touched.
- The `sliceTests` grammar (item kinds, `error[...]`, data sections) is defined
  in `slice-tests.js` and documented in the README's "Slice Tests" section —
  keep generated output within it.
