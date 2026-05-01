---
name: spec-slices
description: Generate one specification file per slice declared in an Event Model DSL. Each spec is markdown with a description section (prose intent) and a tests section (in the eventModelSlice DSL — grammar TBD). Specs are written into a sibling directory `<dsl-file>-slices/`. Existing spec files are preserved — only missing ones are created. The specs are intended for both validation and downstream code generation.
argument-hint: [dsl-file-path]
---

# Slice Specification Generator

Read every `slice` declaration in an Event Model DSL file and stamp out one markdown specification file per slice into a sibling directory. The specs serve as the canonical record of each slice's intent and tests, and are intended to drive both validation and code generation.

## Input

The argument `$ARGUMENTS` is an optional DSL file path.

If absent:
1. Look at the current conversation for the most recently referenced DSL file (a file the user explicitly named, or the last one you read or wrote).
2. Fall back to `blueprint_dsl` in the project root if nothing else applies.

## What to do

1. **Locate the template.** Use the `Bash` tool with `dirname` on the path to this `SKILL.md` to find the skill directory. The template lives at `<skill-dir>/template.md`. Do not hard-code an absolute path.

2. **Read the target DSL file** and parse out every `slice <id>["Label"]` declaration. The label may be omitted, in which case the id doubles as the label.

3. **Compute the spec directory.** Take the DSL file's basename (e.g. `blueprint_dsl`) and append `-slices`, placing the directory in the same parent directory as the DSL file. Example: for `/path/to/blueprint_dsl`, write to `/path/to/blueprint_dsl-slices/`. Create the directory if it does not exist.

4. **For each slice**, do:
   - Compute the spec filename by **slugifying the slice's title** (its label): lowercase the string, replace any run of whitespace or non-alphanumeric characters with a single `-`, trim leading/trailing `-`, and append `.md`. Example: `View Sales Report` → `view-sales-report.md`.
   - **If the file already exists, skip it** — do not overwrite. The user may have authored content in it that you must preserve.
   - Otherwise, read the template once and substitute placeholders:
     - `{{SLICE_TITLE}}` → the slice's label
     - `{{SLICE_ID}}` → the slice's id
   - Write the substituted content to the computed path.

5. **Report the result** to the user: list which spec files were created and which were skipped (because they already existed). Total counts are useful too.

## Notes

- **Don't modify the DSL file.** This skill is read-only with respect to the input; it only writes spec files in the sibling directory.
- **Don't author content in the description or tests sections.** Leave both as placeholder prompts so the user (or a follow-up skill) can fill them in. The point of stamping is to ensure every slice has a place to put its spec, not to invent the spec.
- **The `eventModelSlice` test grammar is TBD.** The template's tests block is intentionally a placeholder. Once the grammar is defined, revise `template.md` and re-running this skill will only create files for newly-added slices — existing specs stay untouched.
- If the DSL file has zero slice declarations, report that and skip creating the directory.

## Refining the template

The template is at `template.md` next to this `SKILL.md`. To change the structure of newly-created specs, edit that file. Existing spec files are not retroactively updated — that's a deliberate property so users can iterate on individual specs without losing changes.
