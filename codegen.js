// codegen.js — Generate Axon Framework 5 (Java, DCB) scaffolding from a slice spec.
//
// A slice spec is a markdown file (or the raw DSL) containing an `eventModel`
// block and a `sliceTests` block. This module turns the *parsed* structures
// into Axon Framework 5 Java that follows the Dynamic Consistency Boundary
// (DCB) style from the official AxonIQ university-demo:
//
//   - command / event types as Java `record`s
//   - a DCB command handler: `@CommandHandler` delegating to a pure
//     `decide(command, state)` returning the events to append
//   - an `@EventSourcedEntity` decision State whose `@EventCriteriaBuilder`
//     is derived from the DSL's `reads [...] by axis` branches — this is the
//     consistency boundary, expressed exactly as Axon 5 wants it
//   - a projection (`@EventHandler`s) for view slices
//   - domain exceptions from `error` items in the tests
//   - `AxonTestFixture` Given/When/Then tests seeded with the example values
//
// Design goals:
//   - Pure & deterministic: same input -> byte-identical output. No DOM, no I/O.
//   - Faithful to Axon 5: types/annotations/imports match the demo's API
//     (org.axonframework.* packages, EventCriteria.either/havingTags/Tag.of...).
//   - Reuses the existing parsers so the DSL keeps a single source of truth.

import { parseEventModel } from "./event-model.js";
import { parseSliceTests } from "./slice-tests.js";

const BASE_PACKAGE = "com.example.eventmodel";

// ─────────────────────────────────────────────────────────────────────────
// Type mapping: DSL primitives → Java. Unknown types become named references
// (custom domain types) emitted verbatim so the code compiles once defined.
// ─────────────────────────────────────────────────────────────────────────
const PRIMITIVE_JAVA = {
  string: "String",
  int: "int",
  integer: "int",
  long: "long",
  decimal: "java.math.BigDecimal",
  float: "double",
  double: "double",
  number: "long",
  boolean: "boolean",
  bool: "boolean",
  date: "java.time.LocalDate",
  timestamp: "java.time.Instant",
  datetime: "java.time.Instant",
  uuid: "java.util.UUID",
};

function javaType(dslType) {
  if (!dslType) return "Object";
  if (Object.prototype.hasOwnProperty.call(PRIMITIVE_JAVA, dslType)) return PRIMITIVE_JAVA[dslType];
  const lower = dslType.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PRIMITIVE_JAVA, lower)) return PRIMITIVE_JAVA[lower];
  // Unknown -> named domain type, keep author's casing (PascalCased).
  return pascal(dslType);
}

// Default value literal for a Java type (used only where a placeholder is needed).
function javaDefault(t) {
  switch (t) {
    case "int": case "long": return "0";
    case "double": return "0.0";
    case "boolean": return "false";
    default: return "null";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Identifier helpers.
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
function constant(s) {
  return words(s).map((w) => w.toUpperCase()).join("_") || "TAG";
}

// ─────────────────────────────────────────────────────────────────────────
// Emit buffer with indentation.
// ─────────────────────────────────────────────────────────────────────────
class Emitter {
  constructor() { this.lines = []; this.depth = 0; }
  line(text = "") { this.lines.push(text === "" ? "" : "    ".repeat(this.depth) + text); return this; }
  push() { this.depth++; return this; }
  pop() { this.depth = Math.max(0, this.depth - 1); return this; }
  blank() { if (this.lines[this.lines.length - 1] !== "") this.lines.push(""); return this; }
  toString() { return this.lines.join("\n").replace(/\n+$/, "") + "\n"; }
}

// ─────────────────────────────────────────────────────────────────────────
// Element partitioning + naming.
// ─────────────────────────────────────────────────────────────────────────
function partition(model) {
  const by = { command: [], domainEvent: [], externalEvent: [], readModel: [], automation: [], ui: [] };
  for (const el of model.elements) if (by[el.kind]) by[el.kind].push(el);
  return by;
}

// Type name for an element (PascalCase of its id). Commands/events read
// naturally as-is (bookRoom -> BookRoom, booked -> Booked); read models get a
// ReadModel suffix to avoid colliding with an event of the same name.
function typeNameFor(el) {
  const base = pascal(el.id);
  if (el.kind === "readModel") return `${base}ReadModel`;
  return base;
}

// Record components (typed parameters) for an element's fields.
function recordComponents(fields) {
  return (fields || []).map((f) => `${javaType(f.type)} ${camel(f.name)}`).join(", ");
}

// The tag axes referenced by a command's read branches (dedup, order-preserving).
function axesOf(el) {
  const seen = new Set();
  const out = [];
  for (const b of el.readBranches || []) {
    for (const a of b.axes || []) {
      if (!seen.has(a)) { seen.add(a); out.push(a); }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Section generators
// ─────────────────────────────────────────────────────────────────────────
function genHeader(out, sliceName) {
  out.line("// ─────────────────────────────────────────────────────────────");
  out.line(`// Generated from slice: ${sliceName}`);
  out.line("// Target: Axon Framework 5 (Dynamic Consistency Boundary style)");
  out.line("// Source of truth is the .md slice spec — regenerate, don't hand-edit.");
  out.line("// ─────────────────────────────────────────────────────────────");
  out.line(`package ${BASE_PACKAGE};`);
  out.blank();
}

// Tag-key constants for the axes used across the slice.
function genTags(out, parts) {
  const axes = new Set();
  for (const cmd of parts.command) for (const a of axesOf(cmd)) axes.add(a);
  // Also surface tag-axis (*) fields declared on events as candidate tags.
  for (const ev of [...parts.domainEvent, ...parts.externalEvent]) {
    for (const f of ev.fields || []) if (f.axis) axes.add(f.name);
  }
  if (axes.size === 0) return;
  out.line("/** Tag keys used to scope the consistency boundary (DCB). */");
  out.line("final class Tags {");
  out.push();
  out.line("private Tags() {}");
  for (const a of axes) out.line(`static final String ${constant(a)} = ${JSON.stringify(a)};`);
  out.pop();
  out.line("}");
  out.blank();
}

function genRecords(out, parts) {
  const groups = [
    ["Commands", parts.command, "command"],
    ["Domain events", parts.domainEvent, "event"],
    ["External events", parts.externalEvent, "event"],
  ];
  for (const [heading, els, role] of groups) {
    if (els.length === 0) continue;
    out.line(`// ${heading}`);
    for (const el of els) {
      const name = typeNameFor(el);
      const comps = recordComponents(el.fields);
      out.line(`/** ${el.label} */`);
      if (role === "command" && axesOf(el).length > 0) {
        // A command needs a @TargetEntityId so Axon can route it to the model.
        // Use the first tag axis as the routing identifier.
        const axis = axesOf(el)[0];
        const hasField = (el.fields || []).some((f) => f.name === axis);
        out.line(`record ${name}(${comps}) {`);
        out.push();
        out.line("@org.axonframework.modelling.annotation.TargetEntityId");
        if (hasField) {
          out.line(`${javaType((el.fields.find((f) => f.name === axis) || {}).type)} routingId() {`);
          out.push().line(`return ${camel(axis)};`).pop();
          out.line("}");
        } else {
          out.line("// TODO: expose the routing identifier for this command's target model.");
          out.line("Object routingId() {");
          out.push().line("return null;").pop();
          out.line("}");
        }
        out.pop();
        out.line("}");
      } else {
        out.line(`record ${name}(${comps}) {}`);
      }
      out.blank();
    }
  }
  // Read-model records (view slices) — plain data carriers.
  if (parts.readModel.length > 0) {
    out.line("// Read models");
    for (const rm of parts.readModel) {
      out.line(`/** ${rm.label} */`);
      out.line(`record ${typeNameFor(rm)}(${recordComponents(rm.fields)}) {}`);
      out.blank();
    }
  }
}

// A command's DCB boundary and its State reference the event types it reads.
// Some of those events are owned by *other* slices (real Axon apps share them
// via a common events package). So the file compiles on its own, emit a stub
// record for any read event that isn't declared in this slice, clearly marked.
function genExternalEventStubs(out, parts, model) {
  const declared = new Set([...parts.domainEvent, ...parts.externalEvent].map((e) => pascal(e.id)));
  const referenced = new Set();
  for (const cmd of parts.command) for (const evId of cmd.reads || []) referenced.add(evId);
  const missing = [...referenced].filter((evId) => !declared.has(pascal(evId)));
  if (missing.length === 0) return;
  out.line("// Events read from other slices. In a real Axon app these live in a");
  out.line("// shared events package; stubbed here so this file compiles standalone.");
  for (const evId of missing) {
    out.line(`record ${pascal(evId)}() { /* TODO: replace with the shared event type */ }`);
  }
  out.blank();
}

// Domain exceptions from `error` items, deduped by code/label.
function genExceptions(out, tests) {
  const seen = new Map();
  for (const t of tests) {
    for (const item of [...t.given, ...t.when, ...t.then]) {
      if (item.kind !== "error") continue;
      const key = item.code || item.label;
      if (!seen.has(key)) seen.set(key, item);
    }
  }
  if (seen.size === 0) return;
  out.line("// Domain errors (expected failures declared in the tests)");
  for (const item of seen.values()) {
    const name = pascal(item.code || item.label) + "Exception";
    out.line(`class ${name} extends RuntimeException {`);
    out.push();
    out.line(`public ${name}() {`);
    out.push().line(`super(${JSON.stringify(item.label)});`).pop();
    out.line("}");
    out.pop();
    out.line("}");
    out.blank();
  }
}

// The DCB command handler + @EventSourcedEntity state for a command slice.
function genCommandHandler(out, parts) {
  const commands = parts.command;
  if (commands.length === 0) return false;

  for (const cmd of commands) {
    const cmdType = typeNameFor(cmd);
    const handler = `${cmdType}CommandHandler`;
    const reads = cmd.reads && cmd.reads.length ? cmd.reads : [];
    const axes = axesOf(cmd);

    // Events this command may produce: prefer events it points to via edges,
    // else fall back to all domain events in the slice.
    const producedIds = new Set();
    // (edges live on the model, passed separately; see caller)
    const producible = parts._producedByCommand?.get(cmd.id) || [];
    for (const id of producible) producedIds.add(id);
    const emitted = [...parts.domainEvent, ...parts.externalEvent].filter((e) => producedIds.has(e.id));
    const emittedTypes = emitted.length ? emitted.map(typeNameFor) : ["/* event */ Object"];

    out.line(`class ${handler} {`);
    out.push();

    out.line("@org.axonframework.messaging.commandhandling.annotation.CommandHandler");
    out.line(`void handle(`);
    out.push();
    out.line(`${cmdType} command,`);
    out.line("@org.axonframework.modelling.annotation.InjectEntity State state,");
    out.line("org.axonframework.messaging.eventhandling.gateway.EventAppender eventAppender");
    out.pop();
    out.line(") {");
    out.push();
    out.line("var events = decide(command, state);");
    out.line("eventAppender.append(events);");
    out.pop();
    out.line("}");
    out.blank();

    // Pure decision function.
    out.line(`private java.util.List<Object> decide(${cmdType} command, State state) {`);
    out.push();
    out.line("// TODO: validate invariants against `state`, throwing a domain");
    out.line("// exception to reject, then return the event(s) to append.");
    if (emitted.length === 1) {
      out.line(`// e.g. return java.util.List.of(new ${emittedTypes[0]}(/* ... */));`);
    } else if (emitted.length > 1) {
      out.line(`// e.g. return java.util.List.of(new ${emittedTypes[0]}(/* ... */));`);
    }
    out.line("return java.util.List.of();");
    out.pop();
    out.line("}");
    out.blank();

    // The @EventSourcedEntity decision state.
    out.line("@org.axonframework.eventsourcing.annotation.EventSourcedEntity");
    out.line("static class State {");
    out.push();
    out.line("// TODO: hold just the fields the decision needs, folded from events.");
    out.blank();
    out.line("@org.axonframework.eventsourcing.annotation.reflection.EntityCreator");
    out.line("State() {");
    out.line("}");
    out.blank();
    if (reads.length === 0) {
      out.line("// This command declares no `reads`; the decision needs no prior state.");
    } else {
      for (const evId of reads) {
        const evName = pascal(evId);
        out.line("@org.axonframework.eventsourcing.annotation.EventSourcingHandler");
        out.line(`void evolve(${evName} event) {`);
        out.push();
        out.line("// TODO: update state from this event.");
        out.pop();
        out.line("}");
        out.blank();
      }
    }

    // The consistency boundary: @EventCriteriaBuilder from the reads branches.
    out.line("// Consistency boundary (DCB): one criteria branch per DSL `reads [...] by axis`.");
    out.line("@org.axonframework.eventsourcing.annotation.EventCriteriaBuilder");
    // The builder takes the routing id; use the first axis' Java type if known.
    const idType = "Object";
    out.line(`private static org.axonframework.messaging.eventstreaming.EventCriteria resolveCriteria(${idType} id) {`);
    out.push();
    const branches = cmd.readBranches && cmd.readBranches.length
      ? cmd.readBranches
      : (reads.length ? [{ events: reads, axes }] : []);
    if (branches.length === 0) {
      out.line("return org.axonframework.messaging.eventstreaming.EventCriteria.havingAnyTag();");
    } else if (branches.length === 1) {
      emitBranch(out, branches[0], "return ", ";");
    } else {
      out.line("return org.axonframework.messaging.eventstreaming.EventCriteria.either(");
      out.push();
      branches.forEach((b, i) => {
        emitBranch(out, b, "", i < branches.length - 1 ? "," : "");
      });
      out.pop();
      out.line(");");
    }
    out.pop();
    out.line("}");

    out.pop();
    out.line("}"); // end State

    out.pop();
    out.line("}"); // end handler
    out.blank();
  }
  return true;
}

// Emit one EventCriteria branch: havingTags(Tag.of(AXIS, id)).andBeingOneOfTypes(...)
function emitBranch(out, branch, prefix, suffix) {
  const evTypes = (branch.events || []).map((e) => `${pascal(e)}.class.getName()`);
  const axis = (branch.axes && branch.axes[0]) || null;
  const EC = "org.axonframework.messaging.eventstreaming.EventCriteria";
  const TAG = "org.axonframework.messaging.eventstreaming.Tag";
  if (axis) {
    out.line(`${prefix}${EC}`);
    out.push();
    out.line(`.havingTags(${TAG}.of(Tags.${constant(axis)}, id.toString()))`);
    if (evTypes.length) {
      out.line(`.andBeingOneOfTypes(`);
      out.push();
      evTypes.forEach((t, i) => out.line(t + (i < evTypes.length - 1 ? "," : "")));
      out.pop();
      out.line(`)${suffix}`);
    } else {
      out.line(`.andBeingOneOfTypes()${suffix}`);
    }
    out.pop();
  } else {
    // No axis: match by event types only.
    out.line(`${prefix}${EC}.havingAnyTag().andBeingOneOfTypes(`);
    out.push();
    evTypes.forEach((t, i) => out.line(t + (i < evTypes.length - 1 ? "," : "")));
    out.pop();
    out.line(`)${suffix}`);
  }
}

// A projection for view slices (read models, no command).
function genProjection(out, parts, model) {
  if (parts.command.length > 0) return false;
  const readModels = parts.readModel;
  if (readModels.length === 0) return false;

  const eventIds = new Set([...parts.domainEvent, ...parts.externalEvent].map((e) => e.id));
  const sourcesOf = new Map(readModels.map((rm) => [rm.id, []]));
  for (const e of model.edges) if (sourcesOf.has(e.to) && eventIds.has(e.from)) sourcesOf.get(e.to).push(e.from);

  for (const rm of readModels) {
    const proj = `${pascal(rm.id)}Projection`;
    const sources = sourcesOf.get(rm.id) || [];
    out.line(`class ${proj} {`);
    out.push();
    out.line(`// Projects ${rm.label} from its source events.`);
    if (sources.length === 0) {
      out.line("// TODO: add @EventHandler methods for this read model's source events.");
    }
    for (const evId of sources) {
      const evName = pascal(evId);
      out.line("@org.axonframework.messaging.eventhandling.annotation.EventHandler");
      out.line(`void on(${evName} event) {`);
      out.push();
      out.line(`// TODO: update the ${typeNameFor(rm)} view from this event.`);
      out.pop();
      out.line("}");
      out.blank();
    }
    out.pop();
    out.line("}");
    out.blank();
  }
  return true;
}

// ── Test generation (AxonTestFixture, Given/When/Then) ─────────────────────
function javaLiteral(f) {
  const t = javaType(f.type);
  const raw = f.value == null ? "" : String(f.value).trim();
  if (raw === "") {
    // No example value: emit a type-appropriate placeholder.
    if (t === "String") return '""';
    if (t === "java.util.UUID") return "java.util.UUID.randomUUID()";
    if (t === "java.time.Instant") return "java.time.Instant.now()";
    if (t === "java.time.LocalDate") return "java.time.LocalDate.now()";
    if (t === "java.math.BigDecimal") return "java.math.BigDecimal.ZERO";
    return javaDefault(t);
  }
  const unquoted = /^".*"$/.test(raw) || /^'.*'$/.test(raw) ? raw.slice(1, -1) : raw;
  // Example values in specs are illustrative (e.g. "room-101" for a UUID). For
  // typed literals that must be well-formed at runtime, only emit a strict
  // literal when the value actually parses; otherwise fall back to a safe
  // generator and keep the illustrative value in a trailing comment.
  const withHint = (expr) => `${expr} /* ${unquoted} */`;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(unquoted);
  const isIsoInstant = /^\d{4}-\d{2}-\d{2}T/.test(unquoted);
  const isIsoDate = /^\d{4}-\d{2}-\d{2}$/.test(unquoted);
  switch (t) {
    case "int": return /^-?\d+$/.test(unquoted) ? unquoted : withHint("0");
    case "long": return /^-?\d+$/.test(unquoted) ? unquoted + "L" : withHint("0L");
    case "double": return /^-?\d+(\.\d+)?$/.test(unquoted) ? unquoted : withHint("0.0");
    case "boolean": return /^(true|false)$/i.test(unquoted) ? unquoted.toLowerCase() : withHint("false");
    case "java.util.UUID":
      return isUuid ? `java.util.UUID.fromString(${JSON.stringify(unquoted)})` : withHint("java.util.UUID.randomUUID()");
    case "java.time.Instant":
      return isIsoInstant ? `java.time.Instant.parse(${JSON.stringify(unquoted)})` : withHint("java.time.Instant.now()");
    case "java.time.LocalDate":
      return isIsoDate ? `java.time.LocalDate.parse(${JSON.stringify(unquoted)})` : withHint("java.time.LocalDate.now()");
    case "java.math.BigDecimal":
      return /^-?\d+(\.\d+)?$/.test(unquoted) ? `new java.math.BigDecimal(${JSON.stringify(unquoted)})` : withHint("java.math.BigDecimal.ZERO");
    case "String": return JSON.stringify(unquoted);
    default: return JSON.stringify(unquoted); // named type: leave a string hint
  }
}

// Build a `new Type(...)` expression for a test item, matching the record's
// declared component order. Missing example values fall back to placeholders.
function newExpr(item, labelIndex) {
  const el = labelIndex.get(`${item.kind}:${item.label}`) || labelIndex.get(item.label);
  if (!el) {
    // Not declared in this slice (e.g. a `given` event owned by another slice).
    return null;
  }
  const type = typeNameFor(el);
  const byName = new Map((item.fields || []).map((f) => [f.name, f]));
  const args = (el.fields || []).map((cf) => {
    const provided = byName.get(cf.name);
    return javaLiteral(provided || { name: cf.name, type: cf.type, value: undefined });
  });
  return `new ${type}(${args.join(", ")})`;
}

function genTests(out, tests, model, parts) {
  const real = tests.filter((t) => t.given.length || t.when.length || t.then.length);
  if (real.length === 0) {
    out.line("// No concrete test cases in the spec yet — add `test[...]` blocks");
    out.line("// with given/when/then to generate AxonTestFixture tests here.");
    return;
  }
  const labelIndex = new Map();
  for (const el of model.elements) {
    labelIndex.set(`${el.kind}:${el.label}`, el);
    labelIndex.set(el.label, el);
  }

  const cls = `${pascal((model.slices && model.slices[0] && model.slices[0].id) || "slice")}Test`;
  out.line("// AxonTestFixture tests derived from the slice's sliceTests.");
  out.line(`class ${cls} {`);
  out.push();
  out.line("private org.axonframework.test.fixture.AxonTestFixture fixture;");
  out.blank();
  out.line("@org.junit.jupiter.api.BeforeEach");
  out.line("void setUp() {");
  out.push();
  out.line("// TODO: build the fixture from this slice's configuration, e.g.:");
  out.line("// fixture = AxonTestFixture.with(configurer);");
  out.pop();
  out.line("}");
  out.blank();

  real.forEach((t, ti) => {
    out.line("@org.junit.jupiter.api.Test");
    out.line(`void test${ti + 1}() {`);
    out.push();
    out.line(`// ${t.title}`);

    // given events
    const givenEvents = t.given.filter((it) => it.kind !== "error");
    const whenCmd = t.when.find((it) => it.kind === "command");
    const thenErrors = t.then.filter((it) => it.kind === "error");
    const thenEvents = t.then.filter((it) => it.kind !== "error");

    out.line("fixture.given()");
    out.push();
    for (const g of givenEvents) {
      const expr = newExpr(g, labelIndex);
      if (expr) out.line(`.event(${expr})`);
      else out.line(`// given ${g.label} — type not declared in this slice`);
    }
    out.line(".when()");
    if (whenCmd) {
      const expr = newExpr(whenCmd, labelIndex);
      out.line(`.command(${expr || `/* ${whenCmd.label} */ null`})`);
    } else {
      out.line("// no `when` command (state-view test)");
    }
    out.line(".then()");
    if (thenErrors.length) {
      const err = thenErrors[0];
      out.line(".exceptionSatisfies(e -> org.assertj.core.api.Assertions.assertThat(e)");
      out.push();
      out.line(`.hasMessageContaining(${JSON.stringify(err.label)}));`);
      out.pop();
    } else if (thenEvents.length) {
      const exprs = thenEvents.map((e) => newExpr(e, labelIndex)).filter(Boolean);
      out.line(".success()");
      if (exprs.length) out.line(`.events(${exprs.join(", ")});`);
      else out.line(".noEvents();");
    } else {
      out.line(".success();");
    }
    out.pop();

    out.pop();
    out.line("}");
    out.blank();
  });

  out.pop();
  out.line("}");
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Generate Axon Framework 5 Java from an already-parsed model + tests.
 * @param {object} args
 * @param {object} args.model  parsed eventModel (parseEventModel output)
 * @param {object} args.tests  parsed sliceTests (parseSliceTests output)
 * @param {string} [args.sliceName]  human name for the header comment
 * @returns {string} Java source
 */
export function generateJava({ model, tests, sliceName }) {
  const out = new Emitter();
  const parts = partition(model);

  // Map which events each command produces, from the slice edges (command -> event).
  const eventIds = new Set([...parts.domainEvent, ...parts.externalEvent].map((e) => e.id));
  const producedByCommand = new Map(parts.command.map((c) => [c.id, []]));
  for (const e of model.edges) {
    if (producedByCommand.has(e.from) && eventIds.has(e.to)) producedByCommand.get(e.from).push(e.to);
  }
  parts._producedByCommand = producedByCommand;

  const name =
    sliceName ||
    (model.slices && model.slices[0] && (model.slices[0].label || model.slices[0].id)) ||
    "slice";

  genHeader(out, name);
  genTags(out, parts);
  genRecords(out, parts);
  genExternalEventStubs(out, parts, model);
  genExceptions(out, tests.tests || []);

  const madeHandler = genCommandHandler(out, parts);
  if (!madeHandler) genProjection(out, parts, model);

  genTests(out, tests.tests || [], model, parts);

  return out.toString();
}

/**
 * Convenience: generate directly from a slice `.md` (or raw DSL) string.
 * Both parsers extract their own fenced block, so the whole file can be passed.
 * @param {string} src  slice spec markdown or raw DSL
 * @param {object} [opts]
 * @param {string} [opts.sliceName]
 * @returns {string} Java source
 */
export function generateFromSource(src, opts = {}) {
  const model = parseEventModel(src);
  const tests = parseSliceTests(src);
  return generateJava({ model, tests, sliceName: opts.sliceName });
}
