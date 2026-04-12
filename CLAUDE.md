# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository purpose

This is a scratch/design repository exploring a DSL for rendering Event Model diagrams (à la eventmodeling.org) on top of Mermaid. There is no build system, no tests, and no package manifest — it currently holds a DSL sketch plus reference blueprint images.

## Contents

- `blueprint_dsl` — the working draft of the DSL. Models a hotel booking example (registration, room management, booking, check-in/out, payments).
- `blueprint_large.jpg`, `blueprint_model_only.jpeg` — reference images of the target event-model blueprint the DSL is meant to reproduce.

## DSL shape (as of current draft)

The DSL is indented under a top-level `eventModel` block. Element-declaration lines introduce nodes; arrow lines (`-->`) wire them into the flow. Key forms:

- `actor <Name>` — swimlane actor (e.g. `Manager`, `Guest`).
- `aggregate <Name>` — bounded-context / aggregate label used to qualify events.
- `ui:<Actor> <id>["Label"]` — UI screen owned by an actor.
- `command <id>["Label"]` — command issued from a UI or automation.
- `domainEvent:<Aggregate> <id>["Label"]` — event emitted by an aggregate.
- `readModel <id>["Label"]` — projection / read model.
- `automation:<Actor> <id>["Label"]` — automated process acting on behalf of an actor.
- `a-->b` — flow edge between any two declared ids.
- `{ field: type }` — brace-delimited block after a `command`, `domainEvent`, `ui`, or `readModel` declaration listing typed fields (one `name: type` per line). Supported types include `string`, `int`, `float`, `decimal`, `boolean`, `date`, `timestamp`, `UUID`.

The canonical pattern is `ui → command → domainEvent → readModel → (ui | automation)`, with automations closing loops back to commands. Preserve this ordering when extending `blueprint_dsl`; the two image files are the source of truth for what the rendered output should look like.

## Notes for future work

- There is no parser/renderer yet — if asked to implement one, the DSL in `blueprint_dsl` is the spec, and the blueprint images define the intended visual output.
- Keep element ids lowercase/snake-case and put human-readable text in the `["..."]` label, matching the existing file.
