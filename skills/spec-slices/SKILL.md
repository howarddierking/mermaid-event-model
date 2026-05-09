---
name: spec-slices
description: Generate one specification file per slice declared in an Event Model DSL. Each spec is markdown with a Model section (auto-extracted slice snippet, refreshed on re-run), a Description section (prose intent), and a Tests section (`sliceTests` DSL inside a mermaid fenced block). Specs are written into a sibling directory `<dsl-file>-slices/`. Re-running is repeatable: alive slices keep their Description/Tests, the Model section is refreshed against the current DSL, and orphan files (whose slice id no longer exists in the DSL) are checked for authored content — empty orphans are deleted silently, orphans with prose or real tests prompt the user to pick which current slice to move the content to so no authored data is ever lost.
argument-hint: [dsl-file-path]
---

# Slice Specification Generator

Read every `slice` declaration in an Event Model DSL file and stamp out one markdown specification file per slice into a sibling directory. The specs serve as the canonical record of each slice's intent and tests, and are intended to drive both validation and code generation.

## Input

The argument `$ARGUMENTS` is an optional DSL file path.

If absent:
1. Look at the current conversation for the most recently referenced DSL file (a file the user explicitly named, or the last one you read or wrote).
2. Fall back to `blueprint_dsl.md` in the project root if nothing else applies.

**DSL files are markdown.** Each one is a `.md` file whose DSL lives inside a fenced ```mermaid block whose first content line is `eventModel`. When parsing slices, elements, and edges, look at the lines INSIDE that fence.

## What to do

1. **Locate the template.** Use the `Bash` tool with `dirname` on the path to this `SKILL.md` to find the skill directory. The template lives at `<skill-dir>/template.md`. Do not hard-code an absolute path.

2. **Read the target DSL file** and parse out every `slice <id>["Label"]` declaration. The label may be omitted, in which case the id doubles as the label.

3. **Compute the spec directory.** Take the DSL file's basename (e.g. `blueprint_dsl`) and append `-slices`, placing the directory in the same parent directory as the DSL file. Example: for `/path/to/blueprint_dsl`, write to `/path/to/blueprint_dsl-slices/`. Create the directory if it does not exist.

4. **For each slice**, do:
   - Compute the spec filename by **slugifying the slice's title** (its label): lowercase the string, replace any run of whitespace or non-alphanumeric characters with a single `-`, trim leading/trailing `-`, and append `.md`. Example: `View Sales Report` → `view-sales-report.md`.
   - **Build the slice's eventModel snippet** (the body that goes into the Model section). This snippet is meant to be a self-contained, renderable view of just this slice's piece of the larger model:
     1. Walk the slice's edges to collect every node id it references.
     2. For each node, look up its full declaration in the parsed eventModel: kind (`ui`, `command`, `domainEvent`, `externalEvent`, `readModel`, `automation`), lane qualifier (the actor or aggregate name after the `:`, if any), label, and any data section fields.
     3. Determine which actors are referenced (every `ui:<Actor>` and `automation:<Actor>` member of the slice) and which aggregates are referenced (every `domainEvent:<Aggregate>` member). Preserve the parent file's declaration order so the swimlane stack matches.
     4. Emit the body of an eventModel block — each line indented with one tab so it nests inside the `eventModel` keyword on the line above the substitution. Order:
        - `\tactor <Name>` for each referenced actor (in declaration order)
        - `\taggregate <Name>` for each referenced aggregate (in declaration order)
        - One line per element declaration, copying the original kind/lane/label and (if present) the brace-delimited data section verbatim
        - The `\tslice <id>["<Label>"]` declaration followed by its edges, each at two tabs
     5. The result is a valid eventModel DSL fragment that, when wrapped in a fenced ` ```mermaid ` block with `eventModel` as the first content line, will render exactly the elements and edges that belong to this slice — and nothing else.

   - **If the spec file does NOT exist:** read the template, substitute placeholders, write the file.
     - `{{SLICE_TITLE}}` → the slice's label
     - `{{SLICE_ID}}` → the slice's id
     - `{{SLICE_MODEL_BODY}}` → the snippet built above (no `eventModel` header line — the template already has it)

   - **If the spec file DOES exist:** the skill is re-runnable. Refresh the Model section in place, leaving Description and Tests untouched.
     1. Read the existing file.
     2. Locate the `## Model` heading. The Model section's content runs from the heading up to (but not including) the next `## ` heading or end-of-file.
     3. Replace that section's content with a fresh ` ```mermaid ` fence containing `eventModel` followed by the freshly-built snippet body, ending with the closing fence. The replacement must include exactly one `## Model` heading and one fenced block.
     4. If the file does not contain a `## Model` heading (e.g., it was generated by an older version of this skill), insert a new Model section between the slice id comment block at the top and the first existing `## ` section heading.
     5. Do NOT modify any other section. The Description and Tests sections — and any custom sections the user may have added below — must round-trip unchanged.
     6. Write the file back.

5. **Detect and resolve orphan spec files** — files in the spec directory whose slice id no longer matches any current slice in the DSL. This step runs AFTER step 4 (so newly-created destination files exist and can receive moved content).

   For every `.md` file in the spec directory:

   1. Extract the slice id from the file's `<!-- slice id: <id> -->` comment near the top.
   2. If that id is in the set of current slice ids, the file is alive — already handled by step 4. Skip.
   3. Otherwise the file is an **orphan** — its slice was renamed, removed, or split since this file was last stamped.

   For each orphan, read the file and compare its `## Description` and `## Tests` sections to the corresponding sections in `template.md` (the same template used to stamp new files). Treat a section as **unmodified** when its content matches the template's body modulo whitespace. Treat it as **authored** otherwise — i.e., the user has written prose in the Description or replaced the placeholder `test["Describe what this test verifies"]` skeleton with real test declarations.

   Then handle the orphan:

   - **No authored content** (both Description and Tests are unmodified placeholders): the file is just a leftover stub from a slice that no longer exists. Delete it silently and report the cleanup.

   - **Authored content present**: do NOT delete. Prompt the user with:
     - The orphan's filename and the now-defunct slice id from its comment.
     - A short preview (first ~200 chars) of each authored section.
     - A numbered list of every CURRENT slice (id + label) so they can pick a destination.
     - Plus two non-slice options: `skip` (leave the orphan as-is — it'll surface again next run) and `delete` (remove the file along with its content; only on explicit confirmation).

     If the user picks a current slice as the destination:
     1. Read the destination spec file (created or refreshed in step 4) and inspect its Description and Tests sections.
     2. For each section the orphan has authored content for:
        - If the destination's section is still the unmodified template placeholder, REPLACE it with the orphan's authored content.
        - If the destination already has authored content, surface the conflict — show both, ask the user how to resolve (keep destination, overwrite with orphan's, or move orphan to a different slice).
     3. Write the destination back, then delete the orphan file.

   Process orphans one at a time so the user can give a different answer per file. When all orphans are resolved, proceed to the report.

6. **Report the result** to the user: list which spec files were created (didn't exist before), which had their Model section refreshed (existed and the Model body changed), which were unchanged (existed and the Model body was already current), which orphans were deleted (unmodified placeholder), and which orphans were merged into other slices (with destination noted). Total counts are useful too.

## Notes

- **Don't modify the DSL file.** This skill is read-only with respect to the input; it only writes spec files in the sibling directory.
- **The Model section IS authored** (it's mechanically derived from the parent eventModel and is meant to be a faithful clip of the slice's portion). The Description and Tests sections, on the other hand, should remain as placeholder prompts — the user fills those in. Don't invent prose or tests.
- **The Tests section uses the `sliceTests` DSL** inside a `mermaid` fenced block, so it renders as a Given / When / Then test card in the model viewer alongside the slice's Model section. The template ships with a single `test["…"]` skeleton; the user fills in the actual preconditions, action, and outcomes. See the README's "Slice Tests" section for the grammar.
- If the DSL file has zero slice declarations, report that and skip creating the directory.

## Re-running the skill

The skill is built to be run repeatedly as the parent eventModel evolves, without ever losing data the user has authored. Each invocation:

- **Creates** spec files for any new slices that don't yet have one (using the template).
- **Refreshes** the `## Model` section of every existing spec file whose slice is still alive in the DSL, against the latest declarations and edges. Description, Tests, and any custom sections in those files are untouched.
- **Detects orphans** — files whose slice id no longer matches any current slice (because the slice was renamed, removed, or split). Orphans whose Description and Tests are still the unmodified placeholders are deleted as cleanup. Orphans with authored content (prose in Description, real `test["..."]` declarations, or any other deliberate edit) trigger an interactive prompt: the skill shows the orphan, lists every current slice, and asks which one to move the authored content to. The user can also choose to skip (defer) or delete (with confirmation).

This means you can rename a slice, split a slice into two, or swap out the underlying eventModel structure, and a re-run will leave you with: (a) every current slice having a spec file, (b) Model sections always in sync with the live DSL, (c) every line of authored prose or test you've written either still in its slice or interactively resettled into one you choose. No content is lost silently.

## Refining the template

The template is at `template.md` next to this `SKILL.md`. Editing it changes the *initial scaffold* used when stamping out brand-new spec files. It does NOT retroactively rewrite the Description or Tests sections of existing specs — those are user-owned content. To rewrite an existing spec from a fresh template, delete the file and re-run the skill.
