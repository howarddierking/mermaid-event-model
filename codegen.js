// codegen.js — Generate TypeScript scaffolding from a slice spec.
//
// A slice spec is a markdown file (or the raw DSL) containing an `eventModel`
// block and a `sliceTests` block. This module turns the *parsed* structures
// into TypeScript: typed interfaces for every element, domain error classes,
// a decider/handler skeleton for command slices (or a projection for view
// slices), and Given/When/Then test stubs seeded with the spec's example
// values.
//
// Design goals:
//   - Pure & deterministic: same input → byte-identical output. No DOM, no I/O.
//   - Faithful to the model: names key off element *ids* (labels can collide),
//     tag-axis (`*`) fields are surfaced, and DCB `reads … by axis` boundaries
//     are turned into a typed decision state so the consistency contract is
//     visible in code, not lost.
//   - Reuses the existing parsers so the DSL only has one source of truth.

import { parseEventModel } from "./event-model.js";
import { parseSliceTests } from "./slice-tests.js";

// ─────────────────────────────────────────────────────────────────────────
// Type mapping: DSL primitives → TypeScript. Unknown types are treated as
// named references (custom domain types), emitted verbatim so the generated
// code compiles once the author defines them.
// ─────────────────────────────────────────────────────────────────────────
const PRIMITIVE_TS = {
  string: "string",
  int: "number",
  integer: "number",
  decimal: "number",
  float: "number",
  number: "number",
  boolean: "boolean",
  bool: "boolean",
  date: "string", // ISO-8601 date, e.g. 2026-08-10
  timestamp: "string", // ISO-8601 datetime
  datetime: "string",
  uuid: "string",
  UUID: "string",
};

function tsType(dslType) {
  if (!dslType) return "unknown";
  if (Object.prototype.hasOwnProperty.call(PRIMITIVE_TS, dslType)) {
    return PRIMITIVE_TS[dslType];
  }
  const lower = dslType.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PRIMITIVE_TS, lower)) {
    return PRIMITIVE_TS[lower];
  }
  // Unknown → assume a named domain type. Keep the author's casing.
  return dslType;
}

// ─────────────────────────────────────────────────────────────────────────
// Identifier helpers. Element ids are already valid-ish identifiers, but we
// normalise to PascalCase for type names and camelCase for values, and derive
// error class names from the machine `code` (falling back to the label).
// ─────────────────────────────────────────────────────────────────────────
function words(s) {
  return String(s || "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean);
}

function pascal(s) {
  const w = words(s);
  if (w.length === 0) return "Unnamed";
  const out = w.map((x) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()).join("");
  return /^[A-Za-z_]/.test(out) ? out : "_" + out;
}

function camel(s) {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

// ─────────────────────────────────────────────────────────────────────────
// Small emit buffer with indentation, so the generators read top-down.
// ─────────────────────────────────────────────────────────────────────────
class Emitter {
  constructor() {
    this.lines = [];
    this.depth = 0;
  }
  line(text = "") {
    this.lines.push(text === "" ? "" : "  ".repeat(this.depth) + text);
    return this;
  }
  push() { this.depth++; return this; }
  pop() { this.depth = Math.max(0, this.depth - 1); return this; }
  blank() { if (this.lines[this.lines.length - 1] !== "") this.lines.push(""); return this; }
  toString() {
    // Collapse any trailing blank lines to exactly one terminal newline.
    return this.lines.join("\n").replace(/\n+$/, "") + "\n";
  }
}

// A doc-comment line for a field, noting tag axes (the DCB consistency handle).
function fieldComment(f) {
  if (f.axis) return " // tag axis — consistency boundary handle";
  return "";
}

function emitInterface(out, name, fields, { comment } = {}) {
  if (comment) out.line(`/** ${comment} */`);
  if (!fields || fields.length === 0) {
    out.line(`export interface ${name} {`);
    out.push().line("// no fields declared in the model").pop();
    out.line("}");
    return;
  }
  out.line(`export interface ${name} {`);
  out.push();
  for (const f of fields) {
    out.line(`${f.name}: ${tsType(f.type)};${fieldComment(f)}`);
  }
  out.pop();
  out.line("}");
}

// ─────────────────────────────────────────────────────────────────────────
// Element partitioning by kind, keyed by id so labels can collide safely.
// ─────────────────────────────────────────────────────────────────────────
function partition(model) {
  const by = { command: [], domainEvent: [], externalEvent: [], readModel: [], automation: [], ui: [] };
  for (const el of model.elements) {
    if (by[el.kind]) by[el.kind].push(el);
  }
  return by;
}

// Type name for an element (PascalCase of its id), with a suffix per kind so
// a command and event sharing a label (e.g. "Checked Out") don't collide.
function typeNameFor(el) {
  const base = pascal(el.id);
  switch (el.kind) {
    case "command": return `${base}Command`;
    case "domainEvent":
    case "externalEvent": return `${base}Event`;
    case "readModel": return `${base}ReadModel`;
    case "ui": return `${base}View`;
    default: return base;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Section generators
// ─────────────────────────────────────────────────────────────────────────
function genHeader(out, sliceName) {
  out.line("// ─────────────────────────────────────────────────────────────");
  out.line(`// Generated from slice: ${sliceName}`);
  out.line("// Source of truth is the .md slice spec — regenerate, don't hand-edit.");
  out.line("// ─────────────────────────────────────────────────────────────");
  out.blank();
}

function genTypes(out, parts) {
  const groups = [
    ["Commands", parts.command],
    ["Domain events", parts.domainEvent],
    ["External events", parts.externalEvent],
    ["Read models", parts.readModel],
    ["Views (UI)", parts.ui],
  ];
  for (const [heading, els] of groups) {
    if (els.length === 0) continue;
    out.line(`// ${heading}`);
    for (const el of els) {
      emitInterface(out, typeNameFor(el), el.fields, { comment: el.label });
      out.blank();
    }
  }
}

// Union of all event types in the slice — the decider's output alphabet.
// Always defined so downstream signatures (deciders, projections) can name it;
// when a slice declares no events locally (e.g. a view fed by other slices),
// it falls back to `unknown` rather than leaving a dangling reference.
function genEventUnion(out, parts) {
  const events = [...parts.domainEvent, ...parts.externalEvent];
  out.line(`// Every event this slice can produce or consume.`);
  if (events.length === 0) {
    out.line(`export type DomainEvent = unknown; // no events declared in this slice`);
  } else {
    out.line(`export type DomainEvent = ${events.map(typeNameFor).join(" | ")};`);
  }
  out.blank();
  return "DomainEvent";
}

// Error classes from `error` items across all tests, deduped by code/label.
function genErrors(out, tests) {
  const seen = new Map();
  for (const t of tests) {
    for (const item of [...t.given, ...t.when, ...t.then]) {
      if (item.kind !== "error") continue;
      const key = item.code || item.label;
      if (!seen.has(key)) seen.set(key, item);
    }
  }
  if (seen.size === 0) return [];
  const names = [];
  out.line("// Domain errors (expected failures declared in the tests)");
  for (const item of seen.values()) {
    const name = pascal(item.code || item.label) + "Error";
    names.push(name);
    out.line(`export class ${name} extends Error {`);
    out.push();
    out.line(`static readonly code = ${JSON.stringify(item.code || camel(item.label))};`);
    out.line("constructor(message: string = " + JSON.stringify(item.label) + ") {");
    out.push();
    out.line("super(message);");
    out.line(`this.name = ${JSON.stringify(name)};`);
    out.pop();
    out.line("}");
    out.pop();
    out.line("}");
    out.blank();
  }
  return names;
}

// For a command slice, emit a decider skeleton: (state, command) => events[].
// The decision state is derived from the command's `reads … by axis` branches
// so the DCB consistency boundary is explicit in the signature.
function genDecider(out, parts, eventUnionName) {
  const commands = parts.command;
  if (commands.length === 0) return false;

  for (const cmd of commands) {
    const cmdType = typeNameFor(cmd);
    const stateType = `${pascal(cmd.id)}State`;
    const fnName = `decide${pascal(cmd.id)}`;

    // Decision state: one field per read event stream (kept minimal & typed as
    // the event arrays the decider folds over). Axes are documented.
    out.line(`// Decision state for ${cmd.label}, folded from prior events.`);
    if (cmd.readBranches && cmd.readBranches.length > 0) {
      out.line("// Consistency boundary (DCB):");
      for (const b of cmd.readBranches) {
        const by = b.axes.length ? ` by ${b.axes.join(", ")}` : "";
        out.line(`//   reads [${b.events.join(", ")}]${by}`);
      }
    }
    out.line(`export interface ${stateType} {`);
    out.push();
    const reads = cmd.reads && cmd.reads.length ? cmd.reads : [];
    if (reads.length === 0) {
      out.line("// command declares no `reads` — decision needs no prior state");
    } else {
      for (const evId of reads) {
        out.line(`${camel(evId)}: ReadonlyArray<unknown>;`);
      }
    }
    out.pop();
    out.line("}");
    out.blank();

    const retType = eventUnionName || "unknown";
    out.line(`/**`);
    out.line(` * Decide the outcome of ${cmd.label}.`);
    out.line(` * Pure function: same (state, command) always yields the same events.`);
    out.line(` * Throw a domain error to reject the command.`);
    out.line(` */`);
    out.line(`export function ${fnName}(`);
    out.push();
    out.line(`state: ${stateType},`);
    out.line(`command: ${cmdType},`);
    out.pop();
    out.line(`): ReadonlyArray<${retType}> {`);
    out.push();
    out.line("// TODO: implement the decision. Validate invariants against `state`,");
    out.line("// then return the event(s) to append, or throw a domain error.");
    out.line("throw new Error(" + JSON.stringify(`${fnName} not implemented`) + ");");
    out.pop();
    out.line("}");
    out.blank();
  }
  return true;
}

// For a view slice (read models, no command), emit a projection skeleton per
// read model: fold the source events into the read-model shape.
function genProjections(out, parts, model) {
  if (parts.command.length > 0) return false; // command slices get a decider instead
  const readModels = parts.readModel;
  if (readModels.length === 0) return false;

  // Map read-model id → source event ids from the slice edges (event → rm).
  const eventIds = new Set([...parts.domainEvent, ...parts.externalEvent].map((e) => e.id));
  const sourcesOf = new Map(readModels.map((rm) => [rm.id, []]));
  for (const e of model.edges) {
    if (sourcesOf.has(e.to) && eventIds.has(e.from)) sourcesOf.get(e.to).push(e.from);
  }

  for (const rm of readModels) {
    const rmType = typeNameFor(rm);
    const fnName = `project${pascal(rm.id)}`;
    const sources = sourcesOf.get(rm.id) || [];
    out.line(`/**`);
    out.line(` * Project ${rm.label} from its source events.`);
    if (sources.length) out.line(` * Sources: ${sources.join(", ")}`);
    out.line(` */`);
    out.line(`export function ${fnName}(`);
    out.push();
    out.line("events: ReadonlyArray<DomainEvent>,");
    out.pop();
    out.line(`): ${rmType} {`);
    out.push();
    out.line("// TODO: fold the source events into the read-model shape.");
    out.line("throw new Error(" + JSON.stringify(`${fnName} not implemented`) + ");");
    out.pop();
    out.line("}");
    out.blank();
  }
  return true;
}

// Literal for a field example value. sliceTests values are raw text; quote when
// the TS type is string-like and the value isn't already quoted.
function exampleLiteral(f) {
  if (f.value == null || f.value === "") return undefined;
  const raw = String(f.value).trim();
  const t = tsType(f.type);
  if (t === "number") {
    return /^-?\d+(\.\d+)?$/.test(raw) ? raw : JSON.stringify(raw);
  }
  if (t === "boolean") {
    return /^(true|false)$/i.test(raw) ? raw.toLowerCase() : JSON.stringify(raw);
  }
  // string-like (string/date/timestamp/uuid/custom): ensure it's quoted.
  if (/^".*"$/.test(raw) || /^'.*'$/.test(raw)) return JSON.stringify(raw.slice(1, -1));
  return JSON.stringify(raw);
}

function emitItemLiteral(out, item, typeName, varName) {
  const fields = item.fields || [];
  // Unresolved type (e.g. a `given` event owned by another slice): emit a
  // self-contained inline literal with a note, rather than a dangling type ref.
  if (!typeName) {
    if (fields.length === 0) {
      out.line(`const ${varName} = {}; // ${item.label} — type not declared in this slice`);
      return;
    }
    out.line(`const ${varName} = {`);
    out.push();
    for (const f of fields) {
      const lit = exampleLiteral(f);
      out.line(`${f.name}: ${lit !== undefined ? lit : "undefined"},`);
    }
    out.pop();
    out.line(`}; // ${item.label} — type not declared in this slice`);
    return;
  }
  if (fields.length === 0) {
    out.line(`const ${varName}: ${typeName} = {} as ${typeName}; // TODO: fill fields`);
    return;
  }
  out.line(`const ${varName}: Partial<${typeName}> = {`);
  out.push();
  for (const f of fields) {
    const lit = exampleLiteral(f);
    out.line(`${f.name}: ${lit !== undefined ? lit : "undefined"},`);
  }
  out.pop();
  out.line("};");
}

// Map a test item to the generated type name using the eventModel elements
// (matched by label, since sliceTests reference labels, not ids).
function makeLabelIndex(model) {
  const idx = new Map();
  for (const el of model.elements) {
    // last one wins is fine; labels are generally unique within a slice
    idx.set(`${el.kind}:${el.label}`, el);
    idx.set(el.label, el);
  }
  return idx;
}

// Resolve a test item to a *declared* generated type. Test items reference
// labels, and a `given` may reference an event owned by another slice that
// isn't declared here — in that case there is no local type to name, so we
// return null and the literal is emitted with an inline shape instead. This
// keeps generated files self-contained and compilable (no dangling type refs).
function typeForTestItem(item, labelIndex) {
  if (item.kind === "error") return null;
  const el = labelIndex.get(`${item.kind}:${item.label}`) || labelIndex.get(item.label);
  return el ? typeNameFor(el) : null;
}

function genTests(out, tests, model) {
  const real = tests.filter((t) => t.given.length || t.when.length || t.then.length);
  if (real.length === 0) {
    out.line("// No concrete test cases in the spec yet — add `test[...]` blocks");
    out.line("// with given/when/then to generate runnable stubs here.");
    return;
  }
  const labelIndex = makeLabelIndex(model);
  out.line("// Test stubs derived from the slice's sliceTests (framework-agnostic).");
  out.line("// Each mirrors the spec's Given/When/Then with its example values.");
  out.blank();
  real.forEach((t, ti) => {
    out.line(`export function test_${ti + 1}() {`);
    out.push();
    out.line(`// ${t.title}`);
    // Variable names must be unique within the test function; prefix with the
    // section (given/when/then) and disambiguate repeats with an index.
    const usedNames = new Set();
    const uniqueName = (base, section) => {
      let candidate = `${section}${pascal(base)}`;
      candidate = candidate.charAt(0).toLowerCase() + candidate.slice(1);
      let name = candidate;
      let n = 2;
      while (usedNames.has(name)) name = `${candidate}${n++}`;
      usedNames.add(name);
      return name;
    };
    const emitSection = (label, items) => {
      if (!items.length) return;
      out.line(`// ${label}`);
      for (const item of items) {
        if (item.kind === "error") {
          out.line(`// expect error: ${item.label}${item.code ? ` (${item.code})` : ""}`);
          continue;
        }
        const varName = uniqueName(item.label, label);
        emitItemLiteral(out, item, typeForTestItem(item, labelIndex), varName);
      }
    };
    emitSection("given", t.given);
    emitSection("when", t.when);
    emitSection("then", t.then);
    out.line("// TODO: wire these fixtures into the slice's decider/projection and assert.");
    out.pop();
    out.line("}");
    out.blank();
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Generate TypeScript from an already-parsed model + tests.
 * @param {object} args
 * @param {object} args.model  parsed eventModel (parseEventModel output)
 * @param {object} args.tests  parsed sliceTests (parseSliceTests output)
 * @param {string} [args.sliceName]  human name for the header comment
 * @returns {string} TypeScript source
 */
export function generateTypeScript({ model, tests, sliceName }) {
  const out = new Emitter();
  const parts = partition(model);
  const name =
    sliceName ||
    (model.slices && model.slices[0] && (model.slices[0].label || model.slices[0].id)) ||
    "slice";

  genHeader(out, name);
  genTypes(out, parts);
  const eventUnion = genEventUnion(out, parts);
  genErrors(out, tests.tests || []);

  const madeDecider = genDecider(out, parts, eventUnion);
  if (!madeDecider) genProjections(out, parts, model);

  genTests(out, tests.tests || [], model);

  return out.toString();
}

/**
 * Convenience: generate directly from a slice `.md` (or raw DSL) string.
 * Both parsers extract their own fenced block, so the whole file can be passed.
 * @param {string} src  slice spec markdown or raw DSL
 * @param {object} [opts]
 * @param {string} [opts.sliceName]
 * @returns {string} TypeScript source
 */
export function generateFromSource(src, opts = {}) {
  const model = parseEventModel(src);
  const tests = parseSliceTests(src);
  return generateTypeScript({ model, tests, sliceName: opts.sliceName });
}
