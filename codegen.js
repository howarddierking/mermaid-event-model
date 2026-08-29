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
import { generateRustMainFromCore } from "./codegen-rust.js";
import { parseSliceTests } from "./slice-tests.js";

const BASE_PACKAGE = "com.example.eventmodel";

// The namespace for stored event names. An event's stored name is
// `<NAMESPACE>.<LocalName>` (e.g. "hotel.Registered") and is a permanent,
// language-independent identifier — the migration contract. It is pinned via
// a QualifiedName, deliberately decoupled from the Java class name, so a
// future binding on any stack can read events this one wrote.
const EVENT_NAMESPACE = "hotel";
const MESSAGE_VERSION = "0.0.1";

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
function kebab(s) {
  return words(s).map((w) => w.toLowerCase()).join("-") || "app";
}

// Resource naming for the AWS target, derived from the model's namespace so
// generated stacks are named after the model — not any sibling project.
//   resourcePrefix  → lower-kebab, used in physical names (streams, functions)
//   ResourcePrefix  → PascalCase, used in a human-facing API name
//   apiPath         → plural lower-kebab path segment for the REST resource
const resourcePrefix = kebab(EVENT_NAMESPACE);
const ResourcePrefix = pascal(EVENT_NAMESPACE);
const apiPath = "records";

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

// The local (unqualified) stored name of an event — PascalCase of its id,
// independent of the Java type name. Accepts an element or a raw event id.
function localEventName(elOrId) {
  const id = typeof elOrId === "string" ? elOrId : elOrId.id;
  return pascal(id);
}

// The pinned, language-independent stored name of an event, e.g. "hotel.Registered".
// This is what a future binding on any stack joins on; changing it is a store
// migration, not a refactor.
function storedName(elOrId) {
  return `${EVENT_NAMESPACE}.${localEventName(elOrId)}`;
}

// The Java constant identifier used to reference an event's pinned QualifiedName
// in the generated Names class, e.g. REGISTERED.
function nameConst(elOrId) {
  return constant(localEventName(elOrId));
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

// The set of every event local-name the slice references: declared events plus
// any event read from another slice (which the criteria still name).
function allEventLocalNames(parts) {
  const names = new Map(); // localName -> canonical (first-seen)
  for (const e of [...parts.domainEvent, ...parts.externalEvent]) names.set(localEventName(e), localEventName(e));
  for (const cmd of parts.command) for (const evId of cmd.reads || []) names.set(localEventName(evId), localEventName(evId));
  return [...names.values()];
}

// Pinned event names: a Names class of QualifiedName constants (the migration
// contract) plus a MessageNames resolver that maps each event class to its
// pinned name, decoupled from the class's own package/identity.
function genNames(out, parts) {
  const eventNames = allEventLocalNames(parts);
  if (eventNames.length === 0) return;
  const QN = "org.axonframework.messaging.core.QualifiedName";

  out.line("// Pinned event names — the language-independent migration contract.");
  out.line("// Each stored name (e.g. \"" + storedName(parts.domainEvent[0]?.id || eventNames[0]) + "\") is permanent;");
  out.line("// changing one is a store migration, not a refactor.");
  out.line("final class Names {");
  out.push();
  out.line("private Names() {}");
  for (const ln of eventNames) {
    out.line(`static final ${QN} ${constant(ln)} =`);
    out.push();
    out.line(`new ${QN}(${JSON.stringify(EVENT_NAMESPACE)}, ${JSON.stringify(ln)});`);
    out.pop();
  }
  out.pop();
  out.line("}");
  out.blank();

  // Resolver that pins each event *class* to its stored name independent of the
  // class's own identity. This is the seam a rebind reimplements per stack.
  const NMTR = "org.axonframework.messaging.core.NamespaceMessageTypeResolver";
  const MTR = "org.axonframework.messaging.core.MessageTypeResolver";
  out.line("// Binds each event class to its pinned name, independent of the class's");
  out.line("// own package or identity. A different stack reimplements just this seam.");
  out.line("final class MessageNames {");
  out.push();
  out.line("private MessageNames() {}");
  out.line(`static ${MTR} resolver() {`);
  out.push();
  out.line(`return ${NMTR}.namespace(${JSON.stringify(EVENT_NAMESPACE)})`);
  out.push();
  eventNames.forEach((ln) => {
    out.line(`.message(${pascal(ln)}.class, ${JSON.stringify(ln)}, ${JSON.stringify(MESSAGE_VERSION)})`);
  });
  out.line(".noFallback();");
  out.pop();
  out.pop();
  out.line("}");
  out.pop();
  out.line("}");
  out.blank();
}

// A test that pins every event's stored name independently of its Java class.
// If someone renames the class or moves its package, this test still demands
// the stored name stay "hotel.<Event>" — enforcing the migration contract.
function genEventNamingTest(out, parts) {
  const eventNames = allEventLocalNames(parts);
  if (eventNames.length === 0) return;
  out.line("// Pins stored event names independently of the Java type. A class rename");
  out.line("// or package move must NOT change the stored name — that would break every");
  out.line("// future binding that reads this event store.");
  out.line("class EventNamingTest {");
  out.push();
  eventNames.forEach((ln, i) => {
    out.line("@org.junit.jupiter.api.Test");
    out.line(`void ${camel(ln)}IsStoredAs${pascal(ln)}() {`);
    out.push();
    out.line("var resolver = MessageNames.resolver();");
    out.line(`var type = resolver.resolve(${pascal(ln)}.class).orElseThrow();`);
    out.line("org.assertj.core.api.Assertions.assertThat(type.qualifiedName().name())");
    out.push();
    out.line(`.isEqualTo(${JSON.stringify(storedName(ln))});`);
    out.pop();
    out.pop();
    out.line("}");
    if (i < eventNames.length - 1) out.blank();
  });
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
// The event types are matched by their PINNED QualifiedName (Names.REGISTERED),
// not by X.class.getName(). Keying the store contract off the Java class name
// would bind the event store to this language's type identity; the pinned name
// is what keeps the store readable by a future binding on any stack.
function emitBranch(out, branch, prefix, suffix) {
  const evNames = (branch.events || []).map((e) => `Names.${nameConst(e)}`);
  const axis = (branch.axes && branch.axes[0]) || null;
  const EC = "org.axonframework.messaging.eventstreaming.EventCriteria";
  const TAG = "org.axonframework.messaging.eventstreaming.Tag";
  if (axis) {
    out.line(`${prefix}${EC}`);
    out.push();
    out.line(`.havingTags(${TAG}.of(Tags.${constant(axis)}, id.toString()))`);
    if (evNames.length) {
      out.line(`.andBeingOneOfTypes(`);
      out.push();
      evNames.forEach((t, i) => out.line(t + (i < evNames.length - 1 ? "," : "")));
      out.pop();
      out.line(`)${suffix}`);
    } else {
      out.line(`.andBeingOfAnyType()${suffix}`);
    }
    out.pop();
  } else {
    // No axis: match by event names only.
    out.line(`${prefix}${EC}.havingAnyTag().andBeingOneOfTypes(`);
    out.push();
    evNames.forEach((t, i) => out.line(t + (i < evNames.length - 1 ? "," : "")));
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

// Resolve a test item to its declared element (matched by label).
function elementForItem(item, labelIndex) {
  return labelIndex.get(`${item.kind}:${item.label}`) || labelIndex.get(item.label) || null;
}

// A `new Type(var, var, ...)` expression built from shared local variable
// names (one per record component). This is what lets a field named in the
// `when` command and asserted in the `then` event compare equal: both sides
// reference the SAME local, so an assertion never turns on a synthetic value.
function newExprFromVars(item, labelIndex, varFor) {
  const el = elementForItem(item, labelIndex);
  if (!el) return null;
  const type = typeNameFor(el);
  const args = (el.fields || []).map((cf) => varFor(cf.name, cf.type));
  return `new ${type}(${args.join(", ")})`;
}

// The Java type declared for a field across the slice (falls back to the
// item-provided type). Used so a shared local's declared type is correct.
function fieldTypeIndex(model) {
  const idx = new Map();
  for (const el of model.elements) {
    for (const f of el.fields || []) if (!idx.has(f.name)) idx.set(f.name, f.type);
  }
  return idx;
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
  const typeIndex = fieldTypeIndex(model);

  const cls = `${pascal((model.slices && model.slices[0] && model.slices[0].id) || "slice")}Test`;
  out.line("// AxonTestFixture tests derived from the slice's sliceTests.");
  out.line("// Transcription rule: a test asserts only on the fields it names; every");
  out.line("// other field is a shared synthetic value, identical on both sides of the");
  out.line("// assertion, so no assertion turns on a value the spec did not specify.");
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

    const givenEvents = t.given.filter((it) => it.kind !== "error");
    const whenCmd = t.when.find((it) => it.kind === "command");
    const thenErrors = t.then.filter((it) => it.kind === "error");
    const thenEvents = t.then.filter((it) => it.kind !== "error");
    const allItems = [...givenEvents, ...(whenCmd ? [whenCmd] : []), ...thenEvents];

    // Collect every field referenced by any item in this test, and whether the
    // test names it (provides a value) or leaves it to be synthesised.
    const fieldMeta = new Map(); // name -> { type, providedValue|undefined, named:boolean }
    for (const item of allItems) {
      const el = elementForItem(item, labelIndex);
      if (!el) continue;
      const provided = new Map((item.fields || []).map((f) => [f.name, f]));
      for (const cf of el.fields || []) {
        const cur = fieldMeta.get(cf.name) || { type: cf.type || typeIndex.get(cf.name), named: false, providedValue: undefined };
        const p = provided.get(cf.name);
        if (p && p.value != null && p.value !== "") {
          cur.named = true;
          if (cur.providedValue === undefined) cur.providedValue = p.value;
        }
        fieldMeta.set(cf.name, cur);
      }
    }

    // Declare one local per field. Named fields carry the spec's example value;
    // the rest get a single synthetic value, reused everywhere for consistency.
    const localName = new Map();
    for (const [fname, meta] of fieldMeta) {
      const vn = camel(fname);
      localName.set(fname, vn);
      const lit = javaLiteral({ name: fname, type: meta.type, value: meta.providedValue });
      out.line(`var ${vn} = ${lit};` + (meta.named ? "" : " // synthetic — not asserted by this test"));
    }
    const varFor = (fname, ftype) => {
      if (localName.has(fname)) return localName.get(fname);
      // Field not seen elsewhere; inline a synthetic value.
      return javaLiteral({ name: fname, type: ftype, value: undefined });
    };
    if (fieldMeta.size) out.blank();

    out.line("fixture.given()");
    out.push();
    for (const g of givenEvents) {
      const expr = newExprFromVars(g, labelIndex, varFor);
      if (expr) out.line(`.event(${expr})`);
      else out.line(`// given ${g.label} — type not declared in this slice`);
    }
    out.line(".when()");
    if (whenCmd) {
      const expr = newExprFromVars(whenCmd, labelIndex, varFor);
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
      const exprs = thenEvents.map((e) => newExprFromVars(e, labelIndex, varFor)).filter(Boolean);
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
// Binding manifest (the Reentrant Blueprint's central artifact).
//
// A per-slice, machine-readable link from model element to its realisation.
// Split into:
//   - core:    must come out identical no matter which architecture is
//              underneath. This is what a migration is checked against.
//   - binding: discarded and regenerated on a rebind.
//
// The `unmapped` array lives in the core deliberately: a field the model
// leaves unplaced is unplaced regardless of stack, so a differing unmapped
// list on a rebind is itself the finding.
// ─────────────────────────────────────────────────────────────────────────

// Infer the slice pattern from structure (with an optional markdown hint).
function slicePattern(parts, patternHint) {
  if (patternHint) return patternHint;
  if (parts.command.length > 0) {
    return parts.automation.length > 0 ? "Automation" : "Command";
  }
  if (parts.readModel.length > 0) return "View";
  return "Unknown";
}

// Detect fields the model leaves unplaced. Two kinds, per the blueprint:
//   1. a command/UI field carried by no emitted event
//   2. an emitted-event field whose value has no stated source (not on the
//      triggering command and not on any event the command reads)
// Entries reconciled against decided exclusions are annotated, not dropped —
// the manifest still records them, marking which were deliberate.
function detectUnmapped(parts, producedByCommand, decidedExclusions) {
  const excluded = new Map((decidedExclusions || []).map((d) => [d.field, d.reason || ""]));
  const eventById = new Map([...parts.domainEvent, ...parts.externalEvent].map((e) => [e.id, e]));

  // Union of all fields carried by any emitted event in the slice.
  const emittedFieldNames = new Set();
  for (const e of [...parts.domainEvent, ...parts.externalEvent]) {
    for (const f of e.fields || []) emittedFieldNames.add(f.name);
  }

  const unmapped = [];
  const note = (field, reason) => {
    const entry = { field, reason };
    if (excluded.has(field)) {
      entry.decidedExclusion = true;
      if (excluded.get(field)) entry.decidedReason = excluded.get(field);
    }
    unmapped.push(entry);
  };

  // 1. command / UI fields carried by no emitted event.
  for (const cmd of parts.command) {
    for (const f of cmd.fields || []) {
      if (!emittedFieldNames.has(f.name)) {
        note(`${pascal(cmd.id)}.${f.name}`, "no emitted event carries this field");
      }
    }
  }
  for (const ui of parts.ui) {
    for (const f of ui.fields || []) {
      if (!emittedFieldNames.has(f.name)) {
        note(`${pascal(ui.id)}.${f.name}`, "no emitted event carries this field");
      }
    }
  }

  // 2. emitted-event fields with no stated source (not on the producing command
  //    and not on any event that command reads).
  for (const cmd of parts.command) {
    const produced = producedByCommand.get(cmd.id) || [];
    const cmdFields = new Set((cmd.fields || []).map((f) => f.name));
    for (const evId of produced) {
      const ev = eventById.get(evId);
      if (!ev) continue;
      // A produced field is "sourced" if it comes from the command or from a
      // read event OTHER than this one. A field only present on the event being
      // emitted (e.g. a generated timestamp) has no stated source — even when
      // the command reads past occurrences of that same event type.
      const readFields = new Set();
      for (const readId of cmd.reads || []) {
        if (readId === evId) continue; // reading self doesn't source new fields
        const re = eventById.get(readId);
        for (const f of (re && re.fields) || []) readFields.add(f.name);
      }
      for (const f of ev.fields || []) {
        if (f.axis) continue; // identity/axis fields are sourced by convention
        if (!cmdFields.has(f.name) && !readFields.has(f.name)) {
          note(`${pascal(ev.id)}.${f.name}`, "no source stated; not carried by the command");
        }
      }
    }
  }

  return unmapped;
}

// Build the manifest object (core + binding).
function buildManifest({ model, tests, sliceName, decidedExclusions, patternHint }) {
  const parts = partition(model);
  const eventIds = new Set([...parts.domainEvent, ...parts.externalEvent].map((e) => e.id));
  const producedByCommand = new Map(parts.command.map((c) => [c.id, []]));
  for (const e of model.edges) {
    if (producedByCommand.has(e.from) && eventIds.has(e.to)) producedByCommand.get(e.from).push(e.to);
  }

  const slice = (model.slices && model.slices[0] && model.slices[0].id) || sliceName || "slice";
  const pattern = slicePattern(parts, patternHint);

  // command core (first command, if any). Fields now carry types + axis flags,
  // so the core is a self-sufficient blueprint any binding can generate from.
  const cmd = parts.command[0] || null;
  const commandCore = cmd
    ? {
        id: cmd.id,
        name: typeNameFor(cmd),
        fields: (cmd.fields || []).map((f) => ({ name: f.name, type: f.type, axis: !!f.axis })),
      }
    : null;

  // boundary: the flat union (tags + reads, for the human-readable contract and
  // the diff acceptance test) plus the explicit branch structure a generator
  // needs to emit an OR-of-branches consistency boundary.
  const boundary = cmd
    ? {
        tags: axesOf(cmd),
        reads: (cmd.reads || []).map((id) => storedName(id)),
        branches: (cmd.readBranches || []).map((b) => ({
          events: (b.events || []).map((id) => ({ id, storedAs: storedName(id) })),
          axes: b.axes || [],
        })),
      }
    : null;

  // emitted events with their pinned stored names
  const emittedIds = cmd ? producedByCommand.get(cmd.id) || [] : [];
  const emitList = (emittedIds.length
    ? emittedIds
    : [...parts.domainEvent].map((e) => e.id)
  ).map((id) => ({ name: pascal(id), storedAs: storedName(id) }));

  const unmapped = detectUnmapped(parts, producedByCommand, decidedExclusions);

  // The self-contained blueprint: everything a generator needs to emit ANY
  // binding, all stack-independent. `coreToModel`/`coreToTests` reconstruct a
  // parsed-model-equivalent from this, so generateAwsFromCore /
  // generateAxonFromCore never re-parse the DSL. Fields keep types + axis
  // flags; events keep their lane; tests keep example values and error codes.
  const fieldsOf = (el) =>
    (el.fields || []).map((f) => ({ name: f.name, type: f.type, axis: !!f.axis }));
  const blueprint = {
    elements: model.elements.map((el) => ({
      id: el.id,
      kind: el.kind,
      lane: el.lane ?? null,
      label: el.label,
      fields: fieldsOf(el),
      reads: el.reads || [],
      readBranches: (el.readBranches || []).map((b) => ({
        events: b.events || [],
        axes: b.axes || [],
      })),
    })),
    edges: model.edges.map((e) => ({ from: e.from, to: e.to })),
    slices: (model.slices || []).map((s) => ({
      id: s.id,
      label: s.label,
      edges: (s.edges || []).map((e) => ({ from: e.from, to: e.to })),
      nodeIds: s.nodeIds || [],
    })),
    tests: (tests.tests || []).map((t) => ({
      title: t.title,
      given: t.given, when: t.when, then: t.then,
    })),
  };

  // binding (disposable) — symbols per element, test method references
  const symbols = {};
  for (const el of [...parts.command, ...parts.domainEvent, ...parts.externalEvent]) {
    symbols[pascal(el.id)] = `${BASE_PACKAGE}.${pascal(el.id)}`;
  }
  const testClass = `${pascal(slice)}Test`;
  const testRefs = (tests.tests || [])
    .filter((t) => t.given.length || t.when.length || t.then.length)
    .map((t, i) => `${testClass}#test${i + 1}`);

  return {
    // ---- core: must survive a change of architecture unchanged ----
    slice,
    pattern,
    ...(commandCore ? { command: commandCore } : {}),
    ...(boundary ? { boundary } : {}),
    emits: emitList,
    unmapped,
    ...(decidedExclusions && decidedExclusions.length ? { decidedExclusions } : {}),
    // The reconstructable model + tests — the generator's actual input.
    blueprint,
    // ---- binding: discarded and regenerated on a rebind ----
    binding: {
      stack: "java-25/axon-5/dcb",
      package: BASE_PACKAGE,
      symbols,
      tests: testRefs,
    },
  };
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
export function generateJava({ model, tests, sliceName, decidedExclusions = [] }) {
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
  genUnmappedAndExclusions(out, parts, producedByCommand, decidedExclusions);
  genTags(out, parts);
  genNames(out, parts);
  genRecords(out, parts);
  genExternalEventStubs(out, parts, model);
  genExceptions(out, tests.tests || []);

  const madeHandler = genCommandHandler(out, parts);
  if (!madeHandler) genProjection(out, parts, model);

  genEventNamingTest(out, parts);
  genTests(out, tests.tests || [], model, parts);

  return out.toString();
}

// Emit, as a comment block, the model-layer findings: fields the model leaves
// unmapped and the decided exclusions that account for them. Nothing here is
// "resolved" in code — the blueprint raises these at the model layer. Surfacing
// them keeps them visible in the generated file and reconciled against the spec.
function genUnmappedAndExclusions(out, parts, producedByCommand, decidedExclusions) {
  const unmapped = detectUnmapped(parts, producedByCommand, decidedExclusions);
  if (unmapped.length === 0 && (!decidedExclusions || decidedExclusions.length === 0)) return;
  out.line("// ── Model-layer findings (raised, never resolved in code) ──────────");
  if (unmapped.length) {
    out.line("// Unmapped fields — the model leaves these unplaced:");
    for (const u of unmapped) {
      const tag = u.decidedExclusion ? " [decided exclusion]" : " [OPEN]";
      out.line(`//   - ${u.field}: ${u.reason}${tag}`);
    }
  }
  const orphanExclusions = (decidedExclusions || []).filter(
    (d) => !unmapped.some((u) => u.field === d.field)
  );
  if (orphanExclusions.length) {
    out.line("// Decided exclusions recorded in the spec:");
    for (const d of orphanExclusions) {
      out.line(`//   - ${d.field}${d.reason ? ": " + d.reason : ""}`);
    }
  }
  out.blank();
}

// ─────────────────────────────────────────────────────────────────────────
// Decided exclusions — a slice-spec section that records model-layer decisions
// (a field deliberately carried by no event, etc.) so they round-trip like
// Description and Tests instead of living in a chat transcript. Parsed here in
// a self-contained way (no change to the DSL parsers).
//
// Recognised markdown shape (under a "## Decided Exclusions" heading):
//   - `Command.field` — reason prose            (list item: id then reason)
//   - `Event.field`: reason prose
// Lines that are the template placeholder or empty are ignored.
// ─────────────────────────────────────────────────────────────────────────
export function parseDecidedExclusions(src) {
  if (typeof src !== "string") return [];
  const lines = src.split(/\r?\n/);
  // Find the "## Decided Exclusions" heading (case/spacing tolerant).
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{0,3}#{1,6}\s+decided\s+exclusions\s*$/i.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) return [];
  const out = [];
  // Match `Backticked.id` optionally followed by ": reason" or " — reason".
  const itemRe = /^\s*[-*]\s*`?([A-Za-z_][\w.]*)`?\s*(?:[:—-]\s*(.*))?$/;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s{0,3}#{1,6}\s+\S/.test(raw)) break; // next heading ends the section
    const line = raw.trim();
    if (!line) continue;
    // Skip an italic/template placeholder line.
    if (/^_.*_$/.test(line) || /^\*.*\*$/.test(line)) continue;
    const m = raw.match(itemRe);
    if (m && m[1].includes(".")) {
      out.push({ field: m[1], reason: (m[2] || "").trim() });
    }
  }
  return out;
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
  const decidedExclusions = parseDecidedExclusions(src);
  return generateJava({ model, tests, sliceName: opts.sliceName, decidedExclusions });
}

/**
 * Generate the binding manifest directly from a slice `.md` (or raw DSL) string.
 * @param {string} src
 * @param {object} [opts]
 * @param {string} [opts.sliceName]
 * @returns {string} pretty-printed JSON manifest
 */
export function generateManifestFromSource(src, opts = {}) {
  const model = parseEventModel(src);
  const tests = parseSliceTests(src);
  const decidedExclusions = parseDecidedExclusions(src);
  const manifest = buildManifest({ model, tests, sliceName: opts.sliceName, decidedExclusions });
  return JSON.stringify(manifest, null, 2) + "\n";
}

/**
 * The blueprint artifact: the manifest CORE only — the stack-independent
 * contract that must survive a change of architecture unchanged (slice,
 * pattern, command, boundary, emitted event stored-names, unmapped fields,
 * decided exclusions). The disposable `binding` section is deliberately
 * omitted: it belongs to a specific stack and is produced only when code is
 * generated. This is what the authoring UI emits BEFORE (and instead of) code
 * — code generation is a downstream step that consumes the blueprint.
 * @param {string} src  slice spec markdown or raw DSL
 * @param {object} [opts]
 * @param {string} [opts.sliceName]
 * @returns {string} pretty-printed JSON (the manifest core)
 */
export function generateManifestCoreFromSource(src, opts = {}) {
  const model = parseEventModel(src);
  const tests = parseSliceTests(src);
  const decidedExclusions = parseDecidedExclusions(src);
  const { binding, ...core } = buildManifest({
    model,
    tests,
    sliceName: opts.sliceName,
    decidedExclusions,
  });
  return JSON.stringify(core, null, 2) + "\n";
}

// ─────────────────────────────────────────────────────────────────────────
// Slice-spec generation — the BLUEPRINT (Model · Intent · Tests) markdown.
//
// This is the `spec-slices` step of the reentrant lifecycle, ported to JS so
// the viewer can produce the slice spec (register.md-shaped) rather than the
// downstream manifest core. It stamps the ## Model section from the parent
// model (a self-contained eventModel snippet of just this slice) and scaffolds
// Description / Tests. Model is derived; Description/Tests are user-owned.
// ─────────────────────────────────────────────────────────────────────────

// Slugify a slice label the way spec-slices names files: lowercase, runs of
// non-alphanumerics → single '-', trimmed.
function sliceSlug(label) {
  return String(label || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Re-emit an element's DSL declaration line (kind[:lane] id["Label"] [reads ...])
// plus its brace-delimited data section, verbatim-equivalent to the parent.
function elementDslLines(el) {
  const laneQual = el.lane ? `:${el.lane}` : "";
  const label = el.label && el.label !== el.id ? `["${el.label}"]` : "";
  const head = `\t${el.kind}${laneQual} ${el.id}${label}`;
  const lines = [];
  const hasFields = el.fields && el.fields.length;
  if (hasFields) {
    lines.push(`${head} {`);
    for (const f of el.fields) lines.push(`\t\t${f.axis ? "*" : ""}${f.name}: ${f.type}`);
    lines.push("\t}");
  } else {
    lines.push(head);
  }
  // Structured reads branches (reads [...] by axis), one indented line each.
  for (const b of el.readBranches || []) {
    const evs = (b.events || []).join(", ");
    const by = (b.axes && b.axes.length) ? ` by ${b.axes.join(", ")}` : "";
    lines.push(`\t\treads [${evs}]${by}`);
  }
  return lines;
}

// Build the tab-indented eventModel body for one slice — a self-contained
// snippet of just this slice's nodes + edges, mirroring the spec-slices skill.
function buildSliceModelBody(model, slice) {
  const elById = new Map(model.elements.map((e) => [e.id, e]));
  const memberIds = new Set(slice.nodeIds || []);
  const members = [...memberIds].map((id) => elById.get(id)).filter(Boolean);

  // Referenced actors (ui:/automation: lanes) and aggregates (domainEvent:
  // lanes), in the parent's declaration order.
  const referencedActors = new Set();
  const referencedAggs = new Set();
  for (const el of members) {
    if ((el.kind === "ui" || el.kind === "automation") && el.lane) referencedActors.add(el.lane);
    if (el.kind === "domainEvent" && el.lane) referencedAggs.add(el.lane);
  }
  const actors = model.actors.filter((a) => referencedActors.has(a));
  const aggregates = model.aggregates.filter((a) => referencedAggs.has(a));

  const lines = [];
  for (const a of actors) lines.push(`\tactor ${a}`);
  for (const a of aggregates) lines.push(`\taggregate ${a}`);
  // Elements in the parent's declaration order (stable, matches the skill).
  for (const el of model.elements) {
    if (memberIds.has(el.id)) lines.push(...elementDslLines(el));
  }
  const label = slice.label && slice.label !== slice.id ? `["${slice.label}"]` : "";
  lines.push(`\tslice ${slice.id}${label}`);
  for (const e of slice.edges || []) lines.push(`\t\t${e.from}-->${e.to}`);
  return lines.join("\n");
}

// Classify a slice into one of the four canonical patterns from its own edges
// (the spec-slices / add-slices decision table). externalEvent is the sole
// discriminator between Automation and Translation.
function classifySlicePattern(model, slice) {
  const elById = new Map(model.elements.map((e) => [e.id, e]));
  const kindOf = (id) => (elById.get(id) ? elById.get(id).kind : null);
  const edges = slice.edges || [];
  const has = (fromKind, toKind) =>
    edges.some((e) => kindOf(e.from) === fromKind && kindOf(e.to) === toKind);
  const memberKinds = new Set((slice.nodeIds || []).map(kindOf));

  const hasReadToAuto = has("readModel", "automation");
  const hasAutoToCmd = has("automation", "command");
  const readSideEvents = edges
    .filter((e) => kindOf(e.to) === "readModel")
    .map((e) => kindOf(e.from));
  const anyExternalOnReadSide = readSideEvents.includes("externalEvent");

  if (hasReadToAuto && hasAutoToCmd) {
    return anyExternalOnReadSide ? "Translation" : "Automation";
  }
  if (memberKinds.has("command")) {
    if (has("ui", "command")) return "Command";
    if (has("externalEvent", "command")) return "Translation [abbreviated]";
    if (has("domainEvent", "command")) return "Automation [abbreviated]";
    return "Command";
  }
  if (memberKinds.has("readModel")) return "View";
  return "Unclassified";
}

// The slice-spec scaffold (mirrors skills/spec-slices/template.md). Model is
// derived and filled here; Description and Tests are placeholder prompts the
// user owns.
function sliceSpecTemplate({ title, id, pattern, modelBody }) {
  return `# ${title}

<!-- slice id: ${id} -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** ${pattern}

\`\`\`mermaid
eventModel
${modelBody}
\`\`\`

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

\`\`\`mermaid
sliceTests
\ttest["Describe what this test verifies"]
\t\tgiven
\t\t\t# Preconditions: events that have already occurred,
\t\t\t# read models that must be present.
\t\twhen
\t\t\t# The command (or signal) under test. Omit \`when\`
\t\t\t# for state-view tests that only project a read model.
\t\tthen
\t\t\t# Expected outcomes: emitted events, populated read
\t\t\t# models, signals to external systems. For rejection
\t\t\t# scenarios use \`error["<message>"]\` — the message is
\t\t\t# read verbatim by code generation.
\t# Data-section fields may carry example values to demonstrate the
\t# case and seed code-gen fixtures, e.g. { checkIn: date = 2026-08-12 }.
\`\`\`
`;
}

/**
 * Generate the slice-spec BLUEPRINT markdown (Model · Intent · Tests) for one
 * slice, stamped from the parent model. The Model section is derived; the
 * Description and Tests are the template scaffold for the author to fill.
 *
 * @param {string} modelSrc  the parent model markdown/DSL (contains slices)
 * @param {object} [opts]
 * @param {string} [opts.sliceId]  which slice to stamp; defaults to the first
 * @returns {string} slice-spec markdown
 */
export function generateSliceSpecFromModel(modelSrc, opts = {}) {
  const model = parseEventModel(modelSrc);
  if (!model.slices || model.slices.length === 0) {
    throw new Error("the model declares no slices — nothing to stamp a spec from");
  }
  const slice = opts.sliceId
    ? model.slices.find((s) => s.id === opts.sliceId)
    : model.slices[0];
  if (!slice) throw new Error(`slice '${opts.sliceId}' not found in the model`);

  return sliceSpecTemplate({
    title: slice.label || slice.id,
    id: slice.id,
    pattern: classifySlicePattern(model, slice),
    modelBody: buildSliceModelBody(model, slice),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Core-driven generation — the manifest core IS the generator's input.
//
// The enriched core carries a self-contained `blueprint` (elements, edges,
// slices, tests). These adapters reconstruct a parsed-model-equivalent from it
// so the existing generators run unchanged — the same core drives either
// binding, which is the whole point: choose the stack at generation time, not
// at authoring time.
// ─────────────────────────────────────────────────────────────────────────

// Accept the core as a JSON string or an already-parsed object.
function asCore(coreOrJson) {
  const core = typeof coreOrJson === "string" ? JSON.parse(coreOrJson) : coreOrJson;
  if (!core || !core.blueprint) {
    throw new Error(
      "manifest core has no `blueprint` section — regenerate it with the current generator " +
      "(generateManifestCoreFromSource); older cores are not self-sufficient for code generation."
    );
  }
  return core;
}

// Rebuild the parseEventModel-shaped model from a core's blueprint.
function coreToModel(core) {
  const bp = core.blueprint;
  return {
    actors: [],       // layout-only; codegen does not read these
    aggregates: [],
    elements: bp.elements.map((el) => ({
      id: el.id,
      kind: el.kind,
      lane: el.lane ?? null,
      label: el.label,
      fields: (el.fields || []).map((f) => ({ name: f.name, type: f.type, axis: !!f.axis })),
      reads: el.reads || [],
      readBranches: (el.readBranches || []).map((b) => ({
        events: b.events || [],
        axes: b.axes || [],
      })),
    })),
    edges: (bp.edges || []).map((e) => ({ from: e.from, to: e.to })),
    slices: (bp.slices || []).map((s) => ({
      id: s.id,
      label: s.label,
      edges: (s.edges || []).map((e) => ({ from: e.from, to: e.to })),
      nodeIds: s.nodeIds || [],
    })),
  };
}

// Rebuild the parseSliceTests-shaped tests object from a core's blueprint.
function coreToTests(core) {
  return {
    tests: (core.blueprint.tests || []).map((t) => ({
      title: t.title || "",
      given: t.given || [],
      when: t.when || [],
      then: t.then || [],
    })),
  };
}

// Decided exclusions are a core-level list; reuse them for unmapped reconciliation.
function coreDecidedExclusions(core) {
  return core.decidedExclusions || [];
}

/**
 * Generate the AWS-native (CDK + Lambda, TypeScript) binding from a manifest
 * core. The core is the sole input — no DSL, no slice spec.
 * @param {string|object} coreOrJson  a manifest core (JSON string or object)
 * @param {object} [opts]
 * @param {string} [opts.sliceName]
 * @param {('slice'|'runtime'|'infra')} [opts.part]
 * @param {('production'|'minimal')} [opts.tier]
 * @returns {string} TypeScript source
 */
export function generateAwsFromCore(coreOrJson, opts = {}) {
  const core = asCore(coreOrJson);
  return generateAwsNative({
    model: coreToModel(core),
    tests: coreToTests(core),
    sliceName: opts.sliceName || core.slice,
    decidedExclusions: coreDecidedExclusions(core),
    part: opts.part || "slice",
    tier: opts.tier || "production",
  });
}

/**
 * Generate the Axon Framework 5 (Java, DCB) binding from a manifest core.
 * @param {string|object} coreOrJson  a manifest core (JSON string or object)
 * @param {object} [opts]
 * @param {string} [opts.sliceName]
 * @returns {string} Java source
 */
export function generateAxonFromCore(coreOrJson, opts = {}) {
  const core = asCore(coreOrJson);
  return generateJava({
    model: coreToModel(core),
    tests: coreToTests(core),
    sliceName: opts.sliceName || core.slice,
    decidedExclusions: coreDecidedExclusions(core),
  });
}

/**
 * Generate a binding from a manifest core, selecting the target stack.
 * @param {string|object} coreOrJson
 * @param {('aws'|'axon')} target
 * @param {object} [opts]  forwarded to the per-target generator
 * @returns {string} source in the target language
 */
export function generateFromCore(coreOrJson, target, opts = {}) {
  switch (target) {
    case "aws":  return generateAwsFromCore(coreOrJson, opts);
    case "axon": return generateAxonFromCore(coreOrJson, opts);
    case "rust": return generateRustFromCore(coreOrJson, opts);
    default:
      throw new Error(`unknown target '${target}' — expected 'aws', 'axon', or 'rust'`);
  }
}

/**
 * Generate the Rust AWS-native binding (a single Lambda main.rs) from a
 * manifest core. Command slices only.
 * @param {string|object} coreOrJson  a manifest core (JSON string or object)
 * @param {object} [opts]
 * @param {string} [opts.sliceName]
 * @returns {string} Rust source (main.rs)
 */
export function generateRustFromCore(coreOrJson, opts = {}) {
  const core = asCore(coreOrJson);
  return generateRustMainFromCore(core, { sliceName: opts.sliceName || core.slice });
}

/**
 * Convenience: generate the Rust binding directly from a slice `.md` (or raw
 * DSL) string, by first building the enriched manifest core.
 * @param {string} src
 * @param {object} [opts]
 * @returns {string} Rust source (main.rs)
 */
export function generateRustFromSource(src, opts = {}) {
  const core = JSON.parse(generateManifestCoreFromSource(src, { sliceName: opts.sliceName }));
  return generateRustMainFromCore(core, { sliceName: opts.sliceName || core.slice });
}

// ═════════════════════════════════════════════════════════════════════════
// AWS-native target — TypeScript CDK + Lambda handlers.
//
// A second binding of the SAME slice spec onto a serverless CQRS/ES stack that
// mirrors the `aws-native` branch of the sibling loan-originations project:
//
//   - API Gateway → Lambda command handler (write side): load the aggregate's
//     events from a DynamoDB event store, replay to state, validate business
//     rules, persist the new event with optimistic concurrency, publish to
//     Kinesis. Uses @aws-sdk/lib-dynamodb (QueryCommand, PutCommand) and
//     @aws-sdk/client-kinesis (PutRecordCommand), env EVENT_TABLE_NAME /
//     KINESIS_STREAM_NAME — exactly as the real handler does.
//   - DynamoDB Streams → Lambda projector (read side): fold source events into
//     an ElastiCache/Redis read model via ioredis, one branch per source event.
//   - API Gateway → Lambda query handler reading the Redis read model.
//   - CDK constructs (aws-cdk-lib/aws-lambda-nodejs NodejsFunction + API
//     Gateway + DynamoDB Streams event source), matching regional-stack.ts.
//
// Same design goals as the Java target: pure & deterministic (same input →
// byte-identical output, no DOM, no I/O), reuses the shared parsers and the
// same identifier / partitioning / unmapped-detection helpers, so the DSL keeps
// a single source of truth across both bindings.
// ═════════════════════════════════════════════════════════════════════════

// The stored event names live under the same namespace the Java target pins
// (EVENT_NAMESPACE). The AWS store keys events by a bare `eventType` string
// (see events.ts), so the local PascalCase name is the stored name here.

// Type mapping: DSL primitives → TypeScript. Unknown types become named
// references (PascalCase) emitted verbatim so the code compiles once defined.
const PRIMITIVE_TS = {
  string: "string",
  int: "number",
  integer: "number",
  long: "number",
  decimal: "number",
  float: "number",
  double: "number",
  number: "number",
  boolean: "boolean",
  bool: "boolean",
  // Dates/timestamps cross the wire as ISO-8601 strings in the AWS stack.
  date: "string",
  timestamp: "string",
  datetime: "string",
  uuid: "string",
};

function tsType(dslType) {
  if (!dslType) return "unknown";
  if (Object.prototype.hasOwnProperty.call(PRIMITIVE_TS, dslType)) return PRIMITIVE_TS[dslType];
  const lower = dslType.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PRIMITIVE_TS, lower)) return PRIMITIVE_TS[lower];
  return pascal(dslType); // unknown → named domain type
}

// The stored `eventType` string for an event (PascalCase of its id), matching
// the values in the real events.ts EventTypes map.
function tsEventName(elOrId) {
  return localEventName(elOrId);
}

// The SCREAMING_SNAKE key used in the EventTypes const map.
function eventTypeKey(elOrId) {
  return constant(localEventName(elOrId));
}

// A TS field list "name: type;" body for an interface.
function tsInterfaceBody(out, fields) {
  for (const f of fields || []) {
    out.line(`${camel(f.name)}: ${tsType(f.type)};`);
  }
}

// A safe TS string literal.
function tsStr(s) {
  return JSON.stringify(String(s == null ? "" : s));
}

// ── The producedByCommand / source-event maps, shared shape with the Java path.
function producedByCommandMap(model, parts) {
  const eventIds = new Set([...parts.domainEvent, ...parts.externalEvent].map((e) => e.id));
  const produced = new Map(parts.command.map((c) => [c.id, []]));
  for (const e of model.edges) {
    if (produced.has(e.from) && eventIds.has(e.to)) produced.get(e.from).push(e.to);
  }
  return produced;
}

// Unique projector handler name for an (event, read model) pair, e.g.
// onOccupancyForecastedIntoDemandForecast — so a projector serving many read
// models never collides on a shared source event.
function projFnName(evId, rm) {
  return `on${pascal(evId)}Into${pascal(rm.id)}`;
}

// Source events feeding a read model (edges: event -> readModel).
function sourceEventsFor(model, parts, readModelId) {
  const eventIds = new Set([...parts.domainEvent, ...parts.externalEvent].map((e) => e.id));
  const out = [];
  for (const e of model.edges) {
    if (e.to === readModelId && eventIds.has(e.from)) out.push(e.from);
  }
  return out;
}

// Expected validation error messages for a command, copied verbatim from the
// slice's `then error[...]` items (same source the Java exceptions use). These
// become the strings validateCommand returns, exactly like aggregate.ts.
function errorMessagesFor(tests) {
  const seen = new Map(); // message -> code/label
  for (const t of tests) {
    for (const item of [...t.given, ...t.when, ...t.then]) {
      if (item.kind !== "error") continue;
      const msg = item.label;
      if (!seen.has(msg)) seen.set(msg, item.code || item.label);
    }
  }
  return [...seen.keys()];
}

// ─────────────────────────────────────────────────────────────────────────
// AWS-native section generators
// ─────────────────────────────────────────────────────────────────────────
function genAwsHeader(out, sliceName) {
  out.line("// ─────────────────────────────────────────────────────────────");
  out.line(`// Generated from slice: ${sliceName}`);
  out.line("// Target: AWS-native (CDK + Lambda, TypeScript)");
  out.line("// CQRS/Event Sourcing: API Gateway + Lambda + DynamoDB event store");
  out.line("//                      + Kinesis + DynamoDB Streams + ElastiCache (Redis).");
  out.line("// Source of truth is the .md slice spec — regenerate, don't hand-edit.");
  out.line("// ─────────────────────────────────────────────────────────────");
  out.blank();
}

// The same "Model-layer findings" comment block the Java target emits, reusing
// detectUnmapped + the decided-exclusions logic. Kept DRY: identical wording.
function genAwsUnmappedAndExclusions(out, parts, producedByCommand, decidedExclusions) {
  const unmapped = detectUnmapped(parts, producedByCommand, decidedExclusions);
  if (unmapped.length === 0 && (!decidedExclusions || decidedExclusions.length === 0)) return;
  out.line("// ── Model-layer findings (raised, never resolved in code) ──────────");
  if (unmapped.length) {
    out.line("// Unmapped fields — the model leaves these unplaced:");
    for (const u of unmapped) {
      const tag = u.decidedExclusion ? " [decided exclusion]" : " [OPEN]";
      out.line(`//   - ${u.field}: ${u.reason}${tag}`);
    }
  }
  const orphanExclusions = (decidedExclusions || []).filter(
    (d) => !unmapped.some((u) => u.field === d.field)
  );
  if (orphanExclusions.length) {
    out.line("// Decided exclusions recorded in the spec:");
    for (const d of orphanExclusions) {
      out.line(`//   - ${d.field}${d.reason ? ": " + d.reason : ""}`);
    }
  }
  out.blank();
}

// The shared DomainEvent envelope + EventTypes const map (mirrors events.ts).
function genAwsEventTypes(out, parts) {
  const events = [...parts.domainEvent, ...parts.externalEvent];
  out.line("// ── Domain events — immutable facts in the DynamoDB event store ──────");
  out.line("// The stored envelope; `eventType` is the language-independent stored name.");
  out.line("export interface DomainEvent {");
  out.push();
  out.line("aggregateId: string;");
  out.line("version: number;");
  out.line("eventType: string;");
  out.line("timestamp: string;");
  out.line("payload: Record<string, unknown>;");
  out.pop();
  out.line("}");
  out.blank();

  if (events.length > 0) {
    out.line("// Stored event names — the migration contract shared with every binding.");
    out.line("export const EventTypes = {");
    out.push();
    for (const ev of events) {
      out.line(`${eventTypeKey(ev)}: ${tsStr(tsEventName(ev))},`);
    }
    out.pop();
    out.line("} as const;");
    out.blank();
  }
}

// TS interfaces for commands, domain/external events, and read models.
function genAwsInterfaces(out, parts) {
  const groups = [
    ["Commands", parts.command],
    ["Domain events", parts.domainEvent],
    ["External events", parts.externalEvent],
    ["Read models", parts.readModel],
  ];
  for (const [heading, els] of groups) {
    if (!els.length) continue;
    out.line(`// ${heading}`);
    for (const el of els) {
      out.line(`/** ${el.label} */`);
      out.line(`export interface ${typeNameFor(el)} {`);
      out.push();
      tsInterfaceBody(out, el.fields);
      out.pop();
      out.line("}");
      out.blank();
    }
  }
}

// createEvent factory (mirrors events.ts) — only when the slice stores events.
function genAwsCreateEvent(out, parts) {
  if (parts.domainEvent.length === 0 && parts.externalEvent.length === 0) return;
  out.line("// Factory for a stored event (stamps the ISO timestamp).");
  out.line("export function createEvent(");
  out.push();
  out.line("aggregateId: string,");
  out.line("version: number,");
  out.line("eventType: string,");
  out.line("payload: Record<string, unknown>");
  out.pop();
  out.line("): DomainEvent {");
  out.push();
  out.line("return { aggregateId, version, eventType, timestamp: new Date().toISOString(), payload };");
  out.pop();
  out.line("}");
  out.blank();
}

// The aggregate: rehydrate(events) folds events into state; validateCommand
// returns an error string (verbatim from the tests) or null. Mirrors the real
// aggregate.ts style (state = fold over events, validate against status).
function genAwsAggregate(out, parts, model, tests) {
  const cmds = parts.command;
  if (cmds.length === 0) return;

  const producedByCommand = producedByCommandMap(model, parts);
  const readEventIds = new Set();
  for (const cmd of cmds) for (const r of cmd.reads || []) readEventIds.add(r);
  const knownEvents = new Map([...parts.domainEvent, ...parts.externalEvent].map((e) => [e.id, e]));

  // The set of fields the folded state may carry: union of read + produced
  // event fields, plus a status + version the lifecycle needs.
  const stateFields = new Map(); // name -> tsType
  for (const id of readEventIds) {
    const ev = knownEvents.get(id);
    for (const f of (ev && ev.fields) || []) stateFields.set(camel(f.name), tsType(f.type));
  }
  for (const cmd of cmds) {
    for (const id of producedByCommand.get(cmd.id) || []) {
      const ev = knownEvents.get(id);
      for (const f of (ev && ev.fields) || []) stateFields.set(camel(f.name), tsType(f.type));
    }
  }

  out.line("// ── Decision state — never stored; folded from the boundary events ──");
  out.line("// rehydrate() folds the events inside the command's consistency boundary");
  out.line("// (the events readBoundary() returned); validateCommand() enforces the");
  out.line("// slice's business rules. This is the pure core of the write side. There is");
  out.line("// no aggregate id or version — the boundary is a tag-scoped set of events,");
  out.line("// and `eventCount` records how many were folded (for reference/debugging).");
  out.line("export interface DecisionState {");
  out.push();
  out.line("status: string | null;");
  for (const [name, ty] of stateFields) {
    if (name === "status" || name === "eventCount") continue;
    out.line(`${name}?: ${ty};`);
  }
  out.line("eventCount: number;");
  out.pop();
  out.line("}");
  out.blank();

  out.line("export function rehydrate(events: DomainEvent[]): DecisionState {");
  out.push();
  out.line("let state: DecisionState = { status: null, eventCount: 0 };");
  out.line("for (const event of events) state = applyEvent(state, event);");
  out.line("return state;");
  out.pop();
  out.line("}");
  out.blank();

  // applyEvent: one case per event the command(s) read (the events that shape
  // state). Fold each event's fields into state; status is left as a TODO the
  // lifecycle rules drive.
  out.line("function applyEvent(state: DecisionState, event: DomainEvent): DecisionState {");
  out.push();
  out.line("switch (event.eventType) {");
  out.push();
  const foldEvents = [...readEventIds].map((id) => knownEvents.get(id)).filter(Boolean);
  if (foldEvents.length === 0) {
    out.line("// This command reads no prior events; state starts empty.");
  }
  for (const ev of foldEvents) {
    out.line(`case EventTypes.${eventTypeKey(ev)}:`);
    out.push();
    out.line("return {");
    out.push();
    out.line("...state,");
    out.line(`// TODO: set the status this event transitions to (e.g. '${constant(ev.id)}').`);
    out.line(`status: state.status,`);
    for (const f of ev.fields || []) {
      // Tag-axis (*) values live on event.tags (always strings); plain fields
      // on event.payload. Tags cast through `unknown` since the stored tag is a
      // string even when the field's declared type is numeric.
      if (f.axis) {
        const t = tsType(f.type);
        const cast = t === "string" ? "as string" : `as unknown as ${t}`;
        out.line(`${camel(f.name)}: event.tags.${camel(f.name)} ${cast},`);
      } else {
        out.line(`${camel(f.name)}: event.payload.${camel(f.name)} as ${tsType(f.type)},`);
      }
    }
    out.line("eventCount: state.eventCount + 1,");
    out.pop();
    out.line("};");
    out.pop();
  }
  out.line("default:");
  out.push();
  out.line("return state;");
  out.pop();
  out.pop();
  out.line("}");
  out.pop();
  out.line("}");
  out.blank();

  // validateCommand — verbatim error messages from the tests, keyed by command.
  const messages = errorMessagesFor(tests.tests || []);
  out.line("// Business-rule validation. Returns null when valid, else the error");
  out.line("// message — copied verbatim from the slice's `then error[...]` items.");
  out.line("export function validateCommand(");
  out.push();
  out.line("state: DecisionState,");
  out.line("command: string");
  out.pop();
  out.line("): string | null {");
  out.push();
  out.line("switch (command) {");
  out.push();
  for (const cmd of cmds) {
    out.line(`case ${tsStr(typeNameFor(cmd))}:`);
    out.push();
    if ((cmd.reads || []).length === 0) {
      out.line("// Creation command — no prior state to validate against.");
      out.line("return null;");
    } else if (messages.length) {
      out.line("// TODO: gate on state.status; reject with the rule below when invalid.");
      messages.forEach((m) => out.line(`// if (/* invalid */ false) return ${tsStr(m)};`));
      out.line("return null;");
    } else {
      out.line("// TODO: enforce this command's invariants against state.");
      out.line("return null;");
    }
    out.pop();
  }
  out.line("default:");
  out.push();
  out.line("return `Unknown command: ${command}`;");
  out.pop();
  out.pop();
  out.line("}");
  out.pop();
  out.line("}");
  out.blank();

  // Surface the verbatim rules as a reference block so they're visible even
  // where the TODO branches above are still stubs.
  if (messages.length) {
    out.line("// Business rules enforced by this slice (verbatim from the spec tests):");
    for (const m of messages) out.line(`//   - ${m}`);
    out.blank();
  }
}

// The command Lambda handler — load/replay/validate/persist/publish. Mirrors
// commands/handler.ts: @aws-sdk/lib-dynamodb QueryCommand + PutCommand for the
// event store (the DCB `reads` boundary is a query keyed by aggregateId with
// optimistic concurrency on version) and @aws-sdk/client-kinesis to publish.
function genAwsCommandHandler(out, parts, model) {
  const cmds = parts.command;
  if (cmds.length === 0) return false;
  const producedByCommand = producedByCommandMap(model, parts);
  const MAX_RETRIES = 5;
  // A command is automation-driven — and so calls a SageMaker endpoint for
  // inference — only when an `automation --> <command>` edge targets it. This
  // is per-command, not per-file: a consolidated handler holds many commands,
  // and only the ones fed by an automation get the inference step (a plain
  // Command slice like check-in must not).
  const automationIds = new Set(parts.automation.map((a) => a.id));
  const automationDrivenCmdIds = new Set(
    model.edges.filter((e) => automationIds.has(e.from)).map((e) => e.to)
  );

  out.line("// ── Command Lambda (write side, DCB-enforced) ───────────────────────");
  out.line("// API Gateway → this handler. Each command's `reads [types] by [axes]`");
  out.line("// becomes a consistency boundary: readBoundary() queries the per-axis");
  out.line("// GSIs and folds the matching events into decision state; the new event");
  out.line("// is appended with appendWithinBoundary(), which atomically asserts the");
  out.line("// boundary has not moved (TransactWriteItems over per-tag guard items) and");
  out.line("// retries on ConcurrencyError. State, event store, and helpers come from");
  out.line("// the shared runtime.");
  out.line("import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';");
  out.blank();

  out.line("const MAX_RETRIES = " + MAX_RETRIES + ";");
  out.blank();

  out.line("export async function handler(");
  out.push();
  out.line("event: APIGatewayProxyEvent");
  out.pop();
  out.line("): Promise<APIGatewayProxyResult> {");
  out.push();
  out.line("try {");
  out.push();
  out.line("if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });");
  out.line("const body = event.body ? JSON.parse(event.body) : {};");
  if (cmds.length === 1) {
    // Single command: no discriminator needed.
    const cmd = cmds[0];
    out.line(`// Only one command in this slice.`);
    out.line(`return handle${typeNameFor(cmd)}(event, body);`);
  } else {
    // Multiple commands: dispatch on a `command` discriminator in the request
    // body (or the `command` path parameter), matched against each command id.
    out.line("// Dispatch on the `command` discriminator (body.command or path).");
    out.line("const command = String(");
    out.push();
    out.line("(body as { command?: unknown }).command ?? event.pathParameters?.command ?? ''");
    out.pop();
    out.line(");");
    out.line("switch (command) {");
    out.push();
    cmds.forEach((cmd) => {
      out.line(`case ${tsStr(cmd.id)}:`);
      out.push();
      out.line(`return handle${typeNameFor(cmd)}(event, body);`);
      out.pop();
    });
    out.line("default:");
    out.push();
    out.line("return response(400, {");
    out.push();
    out.line("error: `Unknown or missing command: '${command}'`,");
    out.line(`commands: [${cmds.map((c) => tsStr(c.id)).join(", ")}],`);
    out.pop();
    out.line("});");
    out.pop();
    out.pop();
    out.line("}");
  }
  out.pop();
  out.line("} catch (err) {");
  out.push();
  out.line("console.error('Command handler error:', err);");
  out.line("return response(500, { error: 'Internal server error' });");
  out.pop();
  out.line("}");
  out.pop();
  out.line("}");
  out.blank();

  const knownEvents = new Map([...parts.domainEvent, ...parts.externalEvent].map((e) => [e.id, e]));

  cmds.forEach((cmd) => {
    const cmdType = typeNameFor(cmd);
    // This command is automation-driven only if an automation edge targets it.
    const isAutomation = automationDrivenCmdIds.has(cmd.id);
    const produced = producedByCommand.get(cmd.id) || [];
    const emitted = produced.length ? produced : parts.domainEvent.map((e) => e.id);
    const firstEvent = emitted[0] || null;
    const ev = firstEvent ? knownEvents.get(firstEvent) : null;
    const branches = cmd.readBranches || [];
    const isCreation = branches.length === 0;
    // Every axis the command scopes by, and every axis the produced event tags.
    const cmdAxes = axesOf(cmd);
    const eventAxisFields = (ev && ev.fields ? ev.fields : []).filter((f) => f.axis);

    out.line(`async function handle${cmdType}(`);
    out.push();
    out.line("event: APIGatewayProxyEvent,");
    out.line("body: Record<string, unknown>");
    out.pop();
    out.line("): Promise<APIGatewayProxyResult> {");
    out.push();

    // Resolve every axis value this command needs (boundary scoping + event
    // tags), from the path (single id) or the body. Deduped, one const each.
    const neededAxes = [...new Set([...cmdAxes, ...eventAxisFields.map((f) => f.name)])];
    for (const axis of neededAxes) {
      const v = camel(axis);
      out.line(`const ${v} = String(event.pathParameters?.id ?? body.${v} ?? '');`);
    }
    // Non-axis command fields (the event payload inputs).
    const payloadFields = (cmd.fields || []).filter((f) => !f.axis && !neededAxes.includes(f.name));
    if (payloadFields.length) {
      out.line(`const { ${payloadFields.map((f) => camel(f.name)).join(", ")} } = body as {`);
      out.push();
      for (const f of payloadFields) out.line(`${camel(f.name)}?: ${tsType(f.type)};`);
      out.pop();
      out.line("};");
    }
    // Validate required axis values are present.
    for (const axis of cmdAxes) {
      const v = camel(axis);
      out.line(`if (!${v}) return response(400, { error: ${tsStr(camel(axis) + " is required")} });`);
    }
    out.blank();

    // Build the tags object the produced event carries. An axis the command
    // itself supplies comes from the resolved local; an axis the command does
    // NOT carry (e.g. `email` on CheckedIn, which originates on the prior
    // `booked` event) is sourced from the rehydrated boundary `state` when a
    // boundary exists, falling back to the local. Empty values are dropped so
    // no empty tag_<axis> GSI key is ever written (DynamoDB rejects those).
    const cmdAxisFieldNames = new Set((cmd.fields || []).map((f) => f.name));
    const emitTagsObject = (hasState) => {
      if (eventAxisFields.length === 0) { out.line("const tags: Record<string, string> = {};"); return; }
      out.line("const tagsRaw: Record<string, string> = {");
      out.push();
      for (const f of eventAxisFields) {
        const local = camel(f.name);
        let expr;
        if (cmdAxisFieldNames.has(f.name)) {
          expr = local; // the command supplies this axis
        } else if (hasState) {
          // Not on the command — take it from the folded boundary state.
          expr = `${local} || (state.${local} == null ? '' : String(state.${local}))`;
        } else {
          expr = local;
        }
        out.line(`${local}: ${expr},`);
      }
      out.pop();
      out.line("};");
      // Drop empty tag values: an unset axis must not become an empty GSI key.
      out.line("const tags: Record<string, string> = Object.fromEntries(");
      out.push();
      out.line("Object.entries(tagsRaw).filter(([, v]) => v !== undefined && v !== '')");
      out.pop();
      out.line(");");
    };

    // Fields the emitted event carries that neither the command supplies nor a
    // tag axis provides — for an automation slice these are the prediction the
    // model returns (recorded as decided exclusions in the slice spec).
    const cmdFieldNamesForSm = new Set((cmd.fields || []).map((f) => f.name));
    const inferredFields = ((ev && ev.fields) || []).filter(
      (f) => !f.axis && !cmdFieldNamesForSm.has(f.name)
    );

    // For an automation slice, invoke the SageMaker endpoint and destructure
    // the inferred fields off its response so the payload builder can use them.
    // `hasState` is true on the boundary path (a `rehydrate(events)` state is in
    // scope) — its read-model-derived fields are the real feature inputs, so we
    // spread it first and let explicit command fields override on collision.
    const emitSageMakerCall = (hasState) => {
      if (!isAutomation) return;
      out.blank();
      out.line("// ── Inference: call the SageMaker endpoint for this slice ──────────");
      out.line("// Feature vector for the model, in precedence order (later overrides");
      out.line("// earlier): the request body (the demand snapshot the caller/scheduler");
      out.line("// supplies), the rehydrated boundary state, then the typed command");
      out.line("// fields. Adjust the shape to match your endpoint's contract.");
      out.line("const features: Record<string, unknown> = {");
      out.push();
      out.line("...body,");
      if (hasState) out.line("...(state as unknown as Record<string, unknown>),");
      for (const f of cmd.fields || []) out.line(`${camel(f.name)}: ${camel(f.name)},`);
      out.pop();
      out.line("};");
      if (inferredFields.length) {
        out.line("// Prediction returned by the endpoint (the event's inferred fields).");
        out.line("const prediction = await invokeSageMaker<{");
        out.push();
        for (const f of inferredFields) out.line(`${camel(f.name)}?: ${tsType(f.type)};`);
        out.pop();
        out.line("}>(features);");
      } else {
        out.line("const prediction = await invokeSageMaker(features);");
      }
      out.blank();
    };

    // Build the payload object from the produced event's non-axis fields. On an
    // automation slice, inferred fields are sourced from the SageMaker response.
    const emitPayloadObject = () => {
      out.line("const payload: Record<string, unknown> = {");
      out.push();
      const cmdFieldNames = new Set((cmd.fields || []).map((f) => f.name));
      const inferredNames = new Set(inferredFields.map((f) => f.name));
      for (const f of (ev && ev.fields) || []) {
        if (f.axis) continue;
        let src;
        if (isAutomation && inferredNames.has(f.name)) {
          src = `prediction.${camel(f.name)}`;
        } else if (cmdFieldNames.has(f.name)) {
          src = camel(f.name);
        } else {
          src = `body.${camel(f.name)}`;
        }
        out.line(`${camel(f.name)}: ${src},`);
      }
      out.pop();
      out.line("};");
    };

    if (isCreation) {
      // No boundary to read: this command is unconditional (a creation). Still
      // written through appendWithinBoundary (with no guards) for a uniform path.
      out.line("// Creation command — no `reads`, so the boundary is empty (no guards).");
      emitTagsObject(false);
      emitSageMakerCall(false);
      emitPayloadObject();
      if (ev) {
        out.line(`const domainEvent = createEvent(EventTypes.${eventTypeKey(ev)}, tags, payload);`);
      } else {
        out.line("const domainEvent = createEvent('TODO', tags, payload);");
      }
      out.line("await appendWithinBoundary(domainEvent, []);");
      out.line("await publishToKinesis(domainEvent);");
      out.line(`return response(201, { eventId: domainEvent.eventId${cmdAxes.length ? ", " + cmdAxes.map((a) => camel(a)).join(", ") : ""} });`);
    } else {
      // Emit the boundary criteria from the DSL read branches.
      out.line("// Consistency boundary (DCB): one branch per DSL `reads [...] by axis`.");
      const axislessBranches = branches.filter((b) => !b.axes || b.axes.length === 0);
      if (axislessBranches.length) {
        out.line("// ── UNSUPPORTED: axis-less `reads` branch ──────────────────────");
        out.line("// This command declares a `reads [...]` with no `by <axis>`, i.e. an");
        out.line("// unbounded criterion matching an event type across ALL tags. That has");
        out.line("// no tag partition to query, so it would require a full-table scan or a");
        out.line("// dedicated per-eventType GSI. Not generated — resolve the model to");
        out.line("// scope this branch by an axis, or implement the scan deliberately.");
        for (const b of axislessBranches) {
          out.line(`// TODO axis-less branch: reads [${(b.events || []).join(", ")}]`);
        }
      }
      out.line("const criteria: BoundaryBranch[] = [");
      out.push();
      for (const b of branches) {
        if (!b.axes || b.axes.length === 0) continue; // axis-less handled above
        const axis = b.axes[0];
        const types = (b.events || []).map((id) => `EventTypes.${eventTypeKey(id)}`).join(", ");
        out.line(`{ axis: ${tsStr(axis)}, value: ${camel(axis)}, types: [${types}] },`);
      }
      out.pop();
      out.line("];");
      out.blank();

      // Retry loop around read → validate → append.
      out.line("for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {");
      out.push();
      out.line("const { events, guards } = await readBoundary(criteria);");
      out.line("const state = rehydrate(events);");
      out.blank();
      out.line("// Enforce business rules against the boundary state.");
      out.line(`const validationError = validateCommand(state, ${tsStr(cmdType)});`);
      out.line("if (validationError) return response(409, { error: validationError });");
      out.blank();
      emitTagsObject(true);
      emitSageMakerCall(true);
      emitPayloadObject();
      if (ev) {
        out.line(`const domainEvent = createEvent(EventTypes.${eventTypeKey(ev)}, tags, payload);`);
      } else {
        out.line("const domainEvent = createEvent('TODO', tags, payload);");
      }
      out.blank();
      out.line("try {");
      out.push();
      out.line("// Atomic: assert the boundary is unchanged, then append.");
      out.line("await appendWithinBoundary(domainEvent, guards);");
      out.line("await publishToKinesis(domainEvent);");
      out.line(`return response(200, { eventId: domainEvent.eventId${cmdAxes.length ? ", " + cmdAxes.map((a) => camel(a)).join(", ") : ""} });`);
      out.pop();
      out.line("} catch (err) {");
      out.push();
      out.line("// A concurrent command moved the boundary — reload and retry.");
      out.line("if (err instanceof ConcurrencyError) continue;");
      out.line("throw err;");
      out.pop();
      out.line("}");
      out.pop();
      out.line("}");
      out.line("return response(409, { error: 'Conflict: boundary contended, retries exhausted' });");
    }
    out.pop();
    out.line("}");
    out.blank();
  });

  // readBoundary / appendWithinBoundary / publishToKinesis / response come from
  // the shared runtime — this file carries only the slice-specific logic.
  return true;
}

// The projector Lambda + query Lambda for a view slice (no command). Mirrors
// projector/handler.ts (DynamoDB Streams → ioredis) and queries/handler.ts.
function genAwsProjection(out, parts, model) {
  if (parts.command.length > 0) return false;
  const readModels = parts.readModel;
  if (readModels.length === 0) return false;
  const knownEvents = new Map([...parts.domainEvent, ...parts.externalEvent].map((e) => [e.id, e]));

  // A projector may serve MANY read models (when generated from the whole
  // model). Build, per read model, its source events and its Redis key info.
  // The dispatch maps each source event to every (read model) it feeds, so one
  // streamed event can update multiple read models; unrelated events are
  // ignored gracefully.
  const rmInfos = readModels.map((rm) => {
    const keyField = (rm.fields || []).find((f) => f.axis) || (rm.fields || [])[0];
    return {
      rm,
      view: typeNameFor(rm),
      prefix: camel(rm.id),
      keyName: keyField ? camel(keyField.name) : "id",
      sources: sourceEventsFor(model, parts, rm.id),
    };
  });
  // event id -> [rmInfo, ...]
  const dispatch = new Map();
  for (const info of rmInfos) {
    for (const evId of info.sources) {
      if (!dispatch.has(evId)) dispatch.set(evId, []);
      dispatch.get(evId).push(info);
    }
  }
  // The primary read model backs the query handler / stack query entry.
  const rm = readModels[0];
  const sources = [...dispatch.keys()];
  const view = rmInfos[0].view;

  // ── Projector: DynamoDB Streams → Redis read model.
  out.line("// ── Projector Lambda (read side) — DynamoDB Streams → Redis ─────────");
  out.line("// Consumes the event store's stream and folds each source event into the");
  out.line("// ElastiCache/Redis read model. The read model is disposable: it can be");
  out.line("// rebuilt at any time by replaying the events. The Redis client and the");
  out.line("// response helper come from the shared runtime.");
  out.line("import { APIGatewayProxyEvent, APIGatewayProxyResult, DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';");
  out.line("import { unmarshall } from '@aws-sdk/util-dynamodb';");
  out.line("import { AttributeValue } from '@aws-sdk/client-dynamodb';");
  out.line("import Redis from 'ioredis';");
  out.blank();

  const keyPrefix = rmInfos[0].prefix;
  out.line("export async function handler(event: DynamoDBStreamEvent): Promise<void> {");
  out.push();
  out.line("const client = getRedis();");
  out.line("for (const record of event.Records) {");
  out.push();
  out.line("if (record.eventName !== 'INSERT') continue;");
  out.line("await processRecord(client, record);");
  out.pop();
  out.line("}");
  out.pop();
  out.line("}");
  out.blank();

  out.line("async function processRecord(client: Redis, record: DynamoDBRecord): Promise<void> {");
  out.push();
  out.line("if (!record.dynamodb?.NewImage) return;");
  out.line("const item = unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>) as DomainEvent;");
  out.line("const { eventId, eventType, timestamp, tags, payload } = item;");
  out.line("switch (eventType) {");
  out.push();
  if (sources.length === 0) {
    out.line("// TODO: no source events wired to any read model in the model edges.");
  }
  for (const evId of sources) {
    out.line(`case EventTypes.${eventTypeKey(evId)}:`);
    out.push();
    // One streamed event may feed several read models — invoke each.
    for (const info of dispatch.get(evId)) {
      const recKey = `tags[${tsStr(info.keyName)}] ?? eventId`;
      out.line(`await ${projFnName(evId, info.rm)}(client, ${recKey}, timestamp, tags, payload);`);
    }
    out.line("break;");
    out.pop();
  }
  out.line("default:");
  out.push();
  out.line("// Event not consumed by any read model in this model — ignore.");
  out.line("break;");
  out.pop();
  out.pop();
  out.line("}");
  out.pop();
  out.line("}");
  out.blank();

  // One handler function per (source event, read model) pair.
  for (const info of rmInfos) {
    for (const evId of info.sources) {
      const ev = knownEvents.get(evId);
      out.line(`async function ${projFnName(evId, info.rm)}(`);
      out.push();
      out.line("client: Redis,");
      out.line("recordKey: string,");
      out.line("timestamp: string,");
      out.line("tags: Record<string, string>,");
      out.line("payload: Record<string, unknown>");
      out.pop();
      out.line("): Promise<void> {");
      out.push();
      out.line(`// Merge ${tsStr(ev ? ev.label : evId)} into the ${info.view} record.`);
      out.line(`const existing = await client.get(\`${info.prefix}:\${recordKey}\`);`);
      out.line(`const view: Record<string, unknown> = existing ? JSON.parse(existing) : { ${info.keyName}: recordKey };`);
      for (const f of (ev && ev.fields) || []) {
        if (f.axis) {
          out.line(`if (tags.${camel(f.name)} !== undefined) view.${camel(f.name)} = tags.${camel(f.name)};`);
        } else {
          out.line(`if (payload.${camel(f.name)} !== undefined) view.${camel(f.name)} = payload.${camel(f.name)};`);
        }
      }
      out.line(`const pipeline = client.pipeline();`);
      out.line(`pipeline.set(\`${info.prefix}:\${recordKey}\`, JSON.stringify(view));`);
      out.line(`pipeline.zadd('${info.prefix}:all', Date.parse(timestamp).toString(), recordKey);`);
      out.line("await pipeline.exec();");
      out.pop();
      out.line("}");
      out.blank();
    }
  }

  // ── Query Lambda snippet (read any read model behind a GET route).
  out.line("// ── Query Lambda (read side) — serves GET from the Redis read models ─");
  out.line("// Reads the projection only; never touches the event store. Selects the");
  out.line("// read model via the `view` query-string param (defaults to the first);");
  out.line("// `GET /api/records?view=demandForecast&id=standard` reads one record,");
  out.line("// omitting `id` lists the most recent. Unknown views return 400.");
  out.line("const READ_MODELS: Record<string, string> = {");
  out.push();
  for (const info of rmInfos) out.line(`${tsStr(info.prefix)}: ${tsStr(info.prefix)},`);
  out.pop();
  out.line("};");
  out.line(`const DEFAULT_VIEW = ${tsStr(rmInfos[0].prefix)};`);
  out.blank();
  out.line("export async function queryHandler(");
  out.push();
  out.line("event: APIGatewayProxyEvent");
  out.pop();
  out.line("): Promise<APIGatewayProxyResult> {");
  out.push();
  out.line("const client = getRedis();");
  out.line("const view = event.queryStringParameters?.view ?? DEFAULT_VIEW;");
  out.line("const prefix = READ_MODELS[view];");
  out.line("if (!prefix) {");
  out.push();
  out.line("return response(400, { error: `Unknown view: '${view}'`, views: Object.keys(READ_MODELS) });");
  out.pop();
  out.line("}");
  out.line("const id = event.pathParameters?.id ?? event.queryStringParameters?.id;");
  out.line("if (id) {");
  out.push();
  out.line("const data = await client.get(`${prefix}:${id}`);");
  out.line("if (!data) return response(404, { error: 'Not found' });");
  out.line("return response(200, JSON.parse(data));");
  out.pop();
  out.line("}");
  out.line("const ids = await client.zrevrange(`${prefix}:all`, 0, 49);");
  out.line("if (ids.length === 0) return response(200, []);");
  out.line("const pipeline = client.pipeline();");
  out.line("for (const key of ids) pipeline.get(`${prefix}:${key}`);");
  out.line("const results = await pipeline.exec();");
  out.line("const items = (results || [])");
  out.push();
  out.line(".map(([err, data]) => (err ? null : data ? JSON.parse(data as string) : null))");
  out.line(".filter(Boolean);");
  out.pop();
  out.line("return response(200, items);");
  out.pop();
  out.line("}");
  out.blank();
  // response() is imported from the shared runtime.
  return true;
}

// A short pointer to where this slice's CDK wiring actually lives. The live,
// compilable stack — the Lambdas, grants, API routes, and the DynamoDB
// Streams event source — is emitted once by the model-level 'infra' target
// (infra/stacks/regional-stack.ts), which is the single source of truth. We
// deliberately do NOT re-emit a per-slice CDK fragment here: it would be inert
// (a handler module has no stack scope), would duplicate the infra, and its
// per-slice topology (one Lambda + route per slice) no longer matches the
// generated stack (a single command/query/projector handler).
function genAwsCdk(out, parts, sliceName) {
  const isCommand = parts.command.length > 0;
  const isView = !isCommand && parts.readModel.length > 0;
  if (!isCommand && !isView) return;

  out.line("// ── CDK wiring ──────────────────────────────────────────────────────");
  out.line("// This handler is wired into infrastructure by the model-level 'infra'");
  out.line("// target — generate infra/stacks/regional-stack.ts (the \"Generate AWS");
  out.line("// infra (CDK)\" action on the model view). That stack declares the Lambda,");
  out.line("// its env + grants, the API Gateway route, and (for read models) the");
  out.line("// DynamoDB Streams event source — the single source of truth for");
  out.line("// deployment. Nothing to paste here.");
  out.blank();
}

// The relative import path a per-slice file uses to reach the shared runtime.
// Slice handlers live at src/<slice>/handler.ts; the shared runtime at
// src/shared/event-store.ts — so the import is one level up.
const AWS_SHARED_MODULE = "../shared/event-store";

// The list of symbols the shared runtime exports and a per-slice file imports.
// Kept here so the emitted import statement and the shared module stay in sync.
function awsSharedImports(parts) {
  const isCommand = parts.command.length > 0;
  // An automation slice pairs a command with an automation element: the command
  // is driven by an automated process that calls out to a model for inference.
  const isAutomation = isCommand && parts.automation.length > 0;
  const base = ["DomainEvent", "EventTypes", "createEvent", "response"];
  if (isCommand) {
    return [
      ...base,
      "BoundaryBranch",
      "readBoundary",
      "appendWithinBoundary",
      "ConcurrencyError",
      "publishToKinesis",
      // Automation slices invoke a SageMaker endpoint before emitting the event.
      ...(isAutomation ? ["invokeSageMaker"] : []),
    ];
  }
  // View slice: the projector/query need the Redis accessor instead of the
  // event-store writers.
  return [...base, "getRedis"];
}

// ── Shared runtime (model level) ───────────────────────────────────────────
// Emitted ONCE from the whole model, not per slice. This is the common part:
// the stored-event envelope, the merged EventTypes map (every event across all
// slices), the createEvent factory, and the event-store / Kinesis / Redis
// plumbing that every slice handler reuses. Slices import from here instead of
// re-emitting it, so N slices no longer produce N copies of the infrastructure.

// The merged EventTypes map: every domain/external event declared anywhere in
// the model, deduped by stored name, ordered by first appearance.
function genAwsSharedEventTypes(out, allEvents) {
  out.line("// ── Domain events — immutable facts in the DynamoDB event store ──────");
  out.line("// The stored envelope. Events are keyed by a unique eventId (PK) and a");
  out.line("// monotonic global `seq` (a ULID). `tags` holds the DCB tag-axis values");
  out.line("// this event carries (e.g. { roomId, email }); each tag is projected into");
  out.line("// a per-axis GSI so a consistency boundary can be queried by tag value.");
  out.line("export interface DomainEvent {");
  out.push();
  out.line("eventId: string;      // unique id (partition key)");
  out.line("seq: string;          // global monotonic sequence (ULID) — total order");
  out.line("eventType: string;    // language-independent stored name");
  out.line("timestamp: string;    // ISO-8601");
  out.line("tags: Record<string, string>;   // DCB tag-axis values carried by this event");
  out.line("payload: Record<string, unknown>;");
  out.pop();
  out.line("}");
  out.blank();

  if (allEvents.length > 0) {
    out.line("// Every stored event name in the model — the migration contract. Merged");
    out.line("// across all slices so there is a single source of truth for event names.");
    out.line("export const EventTypes = {");
    out.push();
    const seen = new Set();
    for (const ev of allEvents) {
      const key = eventTypeKey(ev);
      if (seen.has(key)) continue;
      seen.add(key);
      out.line(`${key}: ${tsStr(tsEventName(ev))},`);
    }
    out.pop();
    out.line("} as const;");
    out.blank();
  }
}

// The shared event-store + Kinesis + Redis runtime: the exact helpers the
// per-slice handlers call. Emitted once at src/shared/event-store.ts.
function genAwsSharedRuntime(out) {
  out.line("// ── AWS clients + config (shared by every handler) ──────────────────");
  out.line("import { APIGatewayProxyResult } from 'aws-lambda';");
  out.line("import { DynamoDBClient } from '@aws-sdk/client-dynamodb';");
  out.line("import {");
  out.push();
  out.line("DynamoDBDocumentClient,");
  out.line("QueryCommand,");
  out.line("GetCommand,");
  out.line("TransactWriteCommand,");
  out.pop();
  out.line("} from '@aws-sdk/lib-dynamodb';");
  out.line("import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';");
  out.line("import {");
  out.push();
  out.line("SageMakerRuntimeClient,");
  out.line("InvokeEndpointCommand,");
  out.pop();
  out.line("} from '@aws-sdk/client-sagemaker-runtime';");
  out.line("import { ulid } from 'ulid';");
  out.line("import Redis from 'ioredis';");
  out.blank();
  out.line("const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {");
  out.line("  // Drop undefined values so optional/unmapped payload fields don't break marshalling.");
  out.line("  marshallOptions: { removeUndefinedValues: true },");
  out.line("});");
  out.line("const kinesis = new KinesisClient({});");
  out.line("const sagemakerRuntime = new SageMakerRuntimeClient({});");
  out.line("const TABLE_NAME = process.env.EVENT_TABLE_NAME!;");
  out.line("const STREAM_NAME = process.env.KINESIS_STREAM_NAME!;");
  out.line("// Endpoint invoked by automation slices that call a model for inference.");
  out.line("// Set on the command Lambda by the CDK stack; empty until an endpoint exists.");
  out.line("const SAGEMAKER_ENDPOINT_NAME = process.env.SAGEMAKER_ENDPOINT_NAME || '';");
  out.blank();

  out.line("// ── Dynamic Consistency Boundary (DCB) primitives ───────────────────");
  out.line("//");
  out.line("// A DCB is defined per command by its `reads [types] by [axes]` criteria: a");
  out.line("// set of event types scoped by tag values. There is no fixed aggregate. We");
  out.line("// enforce the boundary on DynamoDB as follows:");
  out.line("//");
  out.line("//   • Each event stores its tag values in `tags` and is written with one");
  out.line("//     attribute per axis (tag_<axis>) so a per-axis GSI (gsi_<axis>,");
  out.line("//     partition key tag_<axis>, sort key seq) indexes exactly the events");
  out.line("//     carrying that tag. A boundary branch is a Query on that GSI.");
  out.line("//   • GSIs are eventually consistent, so they only SEED the state fold.");
  out.line("//     Enforcement rides on a strongly-consistent guard item per tag value");
  out.line("//     (TAGPOS#<axis>#<value>, holding the last seq appended to that tag),");
  out.line("//     asserted inside a TransactWriteItems. If a concurrent command moved");
  out.line("//     any guard since we read it, the transaction fails and we retry.");
  out.blank();

  out.line("// A single branch of a command's boundary: match these event types among");
  out.line("// events carrying tag <axis> = <value>.");
  out.line("export interface BoundaryBranch {");
  out.push();
  out.line("axis: string;");
  out.line("value: string;");
  out.line("types: readonly string[];");
  out.pop();
  out.line("}");
  out.blank();
  out.line("// The result of reading a boundary: the matching events (for the caller to");
  out.line("// fold) and the guard positions observed, which the append asserts unchanged.");
  out.line("export interface BoundaryRead {");
  out.push();
  out.line("events: DomainEvent[];");
  out.line("guards: { key: string; lastSeq: string | null }[];");
  out.pop();
  out.line("}");
  out.blank();

  out.line("const tagPosKey = (axis: string, value: string) => `TAGPOS#${axis}#${value}`;");
  out.blank();

  out.line("// Factory for a stored event. `tags` are the DCB tag-axis values (e.g.");
  out.line("// { roomId, email }); a fresh ULID gives a globally monotonic seq.");
  out.line("export function createEvent(");
  out.push();
  out.line("eventType: string,");
  out.line("tags: Record<string, string>,");
  out.line("payload: Record<string, unknown>");
  out.pop();
  out.line("): DomainEvent {");
  out.push();
  out.line("return {");
  out.push();
  out.line("eventId: ulid(),");
  out.line("seq: ulid(),");
  out.line("eventType,");
  out.line("timestamp: new Date().toISOString(),");
  out.line("tags,");
  out.line("payload,");
  out.pop();
  out.line("};");
  out.pop();
  out.line("}");
  out.blank();

  out.line("// Query one boundary branch: all events carrying tag <axis> = <value>,");
  out.line("// restricted to the branch's event types. Reads the per-axis GSI. Because");
  out.line("// GSIs are eventually consistent, the result only seeds the state fold —");
  out.line("// enforcement is the guard asserted in appendWithinBoundary.");
  out.line("export async function queryBoundaryBranch(branch: BoundaryBranch): Promise<DomainEvent[]> {");
  out.push();
  out.line("const result = await dynamodb.send(");
  out.push();
  out.line("new QueryCommand({");
  out.push();
  out.line("TableName: TABLE_NAME,");
  out.line("IndexName: `gsi_${branch.axis}`,");
  out.line("KeyConditionExpression: `tag_${branch.axis} = :v`,");
  out.line("ExpressionAttributeValues: { ':v': branch.value },");
  out.line("ScanIndexForward: true, // oldest first, by seq");
  out.pop();
  out.line("})");
  out.pop();
  out.line(");");
  out.line("const items = (result.Items || []) as DomainEvent[];");
  out.line("return items.filter((e) => branch.types.includes(e.eventType));");
  out.pop();
  out.line("}");
  out.blank();

  out.line("// Read the whole boundary: fold-events from every branch (deduped by");
  out.line("// eventId, ordered by seq) plus the strongly-consistent guard position for");
  out.line("// each distinct tag value. The guards are what the append asserts unchanged.");
  out.line("export async function readBoundary(criteria: BoundaryBranch[]): Promise<BoundaryRead> {");
  out.push();
  out.line("// Fold events, seeded from the (eventually consistent) GSIs.");
  out.line("const byId = new Map<string, DomainEvent>();");
  out.line("for (const branch of criteria) {");
  out.push();
  out.line("for (const e of await queryBoundaryBranch(branch)) byId.set(e.eventId, e);");
  out.pop();
  out.line("}");
  out.line("const events = [...byId.values()].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));");
  out.blank();
  out.line("// Strongly-consistent guard read: one TAGPOS item per distinct (axis,value).");
  out.line("const seenKeys = new Set<string>();");
  out.line("const guards: { key: string; lastSeq: string | null }[] = [];");
  out.line("for (const branch of criteria) {");
  out.push();
  out.line("const key = tagPosKey(branch.axis, branch.value);");
  out.line("if (seenKeys.has(key)) continue;");
  out.line("seenKeys.add(key);");
  out.line("const res = await dynamodb.send(");
  out.push();
  out.line("new GetCommand({ TableName: TABLE_NAME, Key: { eventId: key, seq: 'POS' }, ConsistentRead: true })");
  out.pop();
  out.line(");");
  out.line("guards.push({ key, lastSeq: (res.Item?.lastSeq as string | undefined) ?? null });");
  out.pop();
  out.line("}");
  out.line("return { events, guards };");
  out.pop();
  out.line("}");
  out.blank();

  out.line("// Thrown when the boundary moved between read and append; the caller retries.");
  out.line("export class ConcurrencyError extends Error {");
  out.push();
  out.line("constructor() { super('DCB boundary changed; retry'); this.name = 'ConcurrencyError'; }");
  out.pop();
  out.line("}");
  out.blank();

  out.line("// Append an event within its consistency boundary, atomically. In one");
  out.line("// TransactWriteItems we: (1) assert each observed TAGPOS guard is unchanged,");
  out.line("// (2) Put the event (with tag_<axis> attributes so the GSIs index it), and");
  out.line("// (3) advance each TAGPOS guard to this event's seq. If any guard moved, the");
  out.line("// transaction is cancelled and we raise ConcurrencyError.");
  out.line("export async function appendWithinBoundary(");
  out.push();
  out.line("domainEvent: DomainEvent,");
  out.line("guards: { key: string; lastSeq: string | null }[]");
  out.pop();
  out.line("): Promise<void> {");
  out.push();
  out.line("// The item carries a tag_<axis> attribute per tag so each gsi_<axis> indexes it.");
  out.line("// Skip empty/undefined tag values: DynamoDB rejects an empty string as a");
  out.line("// GSI key, and an unset axis simply should not be indexed on this event.");
  out.line("const item: Record<string, unknown> = { ...domainEvent };");
  out.line("for (const [axis, value] of Object.entries(domainEvent.tags)) {");
  out.push();
  out.line("if (value !== undefined && value !== '') item[`tag_${axis}`] = value;");
  out.pop();
  out.line("}");
  out.blank();
  out.line("const txItems: unknown[] = [");
  out.push();
  out.line("{ Put: { TableName: TABLE_NAME, Item: item, ConditionExpression: 'attribute_not_exists(eventId)' } },");
  out.pop();
  out.line("];");
  out.line("for (const g of guards) {");
  out.push();
  out.line("// One operation per item: a single Update that both asserts the guard is");
  out.line("// unchanged (ConditionExpression) and advances it to this event's seq.");
  out.line("// (TransactWriteItems forbids two operations on the same item key, so we");
  out.line("// cannot use a separate ConditionCheck + Update on the same TAGPOS item.)");
  out.line("if (g.lastSeq === null) {");
  out.push();
  out.line("txItems.push({ Update: {");
  out.push();
  out.line("TableName: TABLE_NAME, Key: { eventId: g.key, seq: 'POS' },");
  out.line("UpdateExpression: 'SET lastSeq = :seq',");
  out.line("ConditionExpression: 'attribute_not_exists(lastSeq)',");
  out.line("ExpressionAttributeValues: { ':seq': domainEvent.seq },");
  out.pop();
  out.line("} });");
  out.pop();
  out.line("} else {");
  out.push();
  out.line("txItems.push({ Update: {");
  out.push();
  out.line("TableName: TABLE_NAME, Key: { eventId: g.key, seq: 'POS' },");
  out.line("UpdateExpression: 'SET lastSeq = :seq',");
  out.line("ConditionExpression: 'lastSeq = :prev',");
  out.line("ExpressionAttributeValues: { ':seq': domainEvent.seq, ':prev': g.lastSeq },");
  out.pop();
  out.line("} });");
  out.pop();
  out.line("}");
  out.pop();
  out.line("}");
  out.blank();
  out.line("try {");
  out.push();
  out.line("await dynamodb.send(new TransactWriteCommand({ TransactItems: txItems as never }));");
  out.pop();
  out.line("} catch (err: unknown) {");
  out.push();
  out.line("const name = (err as { name?: string }).name;");
  out.line("if (name === 'TransactionCanceledException' || name === 'ConditionalCheckFailedException') {");
  out.push();
  out.line("throw new ConcurrencyError();");
  out.pop();
  out.line("}");
  out.line("throw err;");
  out.pop();
  out.line("}");
  out.pop();
  out.line("}");
  out.blank();

  out.line("// Publish an event to Kinesis for downstream consumers.");
  out.line("export async function publishToKinesis(domainEvent: DomainEvent): Promise<void> {");
  out.push();
  out.line("await kinesis.send(");
  out.push();
  out.line("new PutRecordCommand({");
  out.push();
  out.line("StreamName: STREAM_NAME,");
  out.line("PartitionKey: domainEvent.eventId,");
  out.line("Data: Buffer.from(JSON.stringify(domainEvent)),");
  out.pop();
  out.line("})");
  out.pop();
  out.line(");");
  out.pop();
  out.line("}");
  out.blank();

  out.line("// Invoke a SageMaker real-time endpoint for inference. Automation slices");
  out.line("// call this to turn a feature vector into a prediction, then record the");
  out.line("// result as a domain event. `features` is JSON-serialised as the request");
  out.line("// body; the parsed JSON response is returned to the caller. Throws if no");
  out.line("// endpoint is configured or the response body is empty.");
  out.line("export async function invokeSageMaker<T = Record<string, unknown>>(");
  out.push();
  out.line("features: Record<string, unknown>,");
  out.line("endpointName: string = SAGEMAKER_ENDPOINT_NAME");
  out.pop();
  out.line("): Promise<T> {");
  out.push();
  out.line("if (!endpointName) {");
  out.push();
  out.line("throw new Error('SAGEMAKER_ENDPOINT_NAME is not set — no endpoint to invoke');");
  out.pop();
  out.line("}");
  out.line("const result = await sagemakerRuntime.send(");
  out.push();
  out.line("new InvokeEndpointCommand({");
  out.push();
  out.line("EndpointName: endpointName,");
  out.line("ContentType: 'application/json',");
  out.line("Accept: 'application/json',");
  out.line("Body: Buffer.from(JSON.stringify(features)),");
  out.pop();
  out.line("})");
  out.pop();
  out.line(");");
  out.line("if (!result.Body) throw new Error('SageMaker returned an empty response body');");
  out.line("const text = Buffer.from(result.Body as Uint8Array).toString('utf-8');");
  out.line("return JSON.parse(text) as T;");
  out.pop();
  out.line("}");
  out.blank();

  out.line("// Lazily-initialised Redis (ElastiCache) client for the read side.");
  out.line("let redis: Redis;");
  out.line("export function getRedis(): Redis {");
  out.push();
  out.line("if (!redis) {");
  out.push();
  out.line("redis = new Redis({");
  out.push();
  out.line("host: process.env.REDIS_HOST!,");
  out.line("port: parseInt(process.env.REDIS_PORT || '6379'),");
  out.line("tls: process.env.REDIS_TLS === 'true' ? {} : undefined,");
  out.line("connectTimeout: 5000,");
  out.line("maxRetriesPerRequest: 3,");
  out.pop();
  out.line("});");
  out.pop();
  out.line("}");
  out.line("return redis;");
  out.pop();
  out.line("}");
  out.blank();

  out.line("// Shared API Gateway JSON response helper.");
  out.line("export function response(statusCode: number, body: unknown): APIGatewayProxyResult {");
  out.push();
  out.line("return {");
  out.push();
  out.line("statusCode,");
  out.line("headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },");
  out.line("body: JSON.stringify(body),");
  out.pop();
  out.line("};");
  out.pop();
  out.line("}");
  out.blank();
}

// The shared CDK infrastructure: the global DynamoDB event table, the Kinesis
// stream, and the API Gateway root — declared once from the whole model, not
// per slice. Per-slice fragments attach their Lambda + route to these.
function genAwsSharedInfra(out, allEvents) {
  out.line("// The shared CDK infrastructure (the DynamoDB event table, Kinesis stream,");
  out.line("// VPC, ElastiCache Redis, API Gateway) is emitted as its own compilable");
  out.line("// file — infra/stacks/regional-stack.ts — via the 'infra' generation part,");
  out.line("// not inlined here. This keeps the runtime module free of stack code.");
  out.blank();
}

// ── Shared CDK infrastructure (model level) ────────────────────────────────
// Emitted as a LIVE, compilable infra/stacks/regional-stack.ts — not a comment
// block. Mirrors the real aws-native RegionalStack: Multi-AZ VPC, a reference
// to the DynamoDB global table, a regional Kinesis stream, a Multi-AZ
// ElastiCache Redis replication group, the command/query/projector Lambdas
// (NodejsFunction) wired with env + grants, an API Gateway (prod stage), and
// the DynamoDB Streams → projector event source. Per-slice handlers plug into
// the src/<slice>/handler.ts entry points this stack references.
function genAwsRegionalStack(out, model, parts, modelName, tier) {
  const hasCommand = parts.command.length > 0 || model.elements.some((e) => e.kind === "command");
  const hasReadModel = parts.readModel.length > 0 || model.elements.some((e) => e.kind === "readModel");
  // An automation anywhere in the model means the command Lambda invokes a
  // SageMaker endpoint, so the stack must grant it and pass the endpoint name.
  const hasAutomation = parts.automation.length > 0 || model.elements.some((e) => e.kind === "automation");
  const minimal = tier === "minimal";

  out.line("// ─────────────────────────────────────────────────────────────");
  out.line(`// Shared infrastructure for model: ${modelName}`);
  out.line("// Target: AWS-native CDK — infra/stacks/regional-stack.ts");
  if (minimal) {
    out.line("// Cost tier: MINIMAL — a low-cost footprint for demos/PoCs: one NAT");
    out.line("// gateway and a single-node ElastiCache Redis (cache.t4g.micro, no");
    out.line("// replicas, no Multi-AZ failover). NOT for production.");
  } else {
    out.line("// Cost tier: PRODUCTION — 3 NAT gateways and a Multi-AZ ElastiCache");
    out.line("// Redis replication group (cache.r7g.large, 1 primary + 2 replicas).");
  }
  out.line("// The COMMON stack, emitted once from the whole model: VPC, the DynamoDB");
  out.line("// global-table reference, a regional Kinesis stream, ElastiCache Redis,");
  out.line("// the command/query/projector Lambdas, and the API Gateway. Deployed");
  out.line("// identically per region. Source of truth is the model .md — regenerate.");
  out.line("// ─────────────────────────────────────────────────────────────");
  out.line("import * as cdk from 'aws-cdk-lib';");
  out.line("import * as ec2 from 'aws-cdk-lib/aws-ec2';");
  out.line("import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';");
  out.line("import * as kinesis from 'aws-cdk-lib/aws-kinesis';");
  out.line("import * as elasticache from 'aws-cdk-lib/aws-elasticache';");
  out.line("import * as lambda from 'aws-cdk-lib/aws-lambda';");
  out.line("import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';");
  out.line("import * as apigateway from 'aws-cdk-lib/aws-apigateway';");
  out.line("import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';");
  if (hasAutomation) out.line("import * as iam from 'aws-cdk-lib/aws-iam';");
  out.line("import { Construct } from 'constructs';");
  out.line("import * as path from 'path';");
  out.blank();

  out.line("export interface RegionalStackProps extends cdk.StackProps {");
  out.push();
  out.line("regionLabel: string;");
  out.line("globalTable: dynamodb.Table;");
  out.line("isPrimary: boolean;");
  if (hasAutomation) {
    out.line("// Name of the SageMaker endpoint automation slices invoke for inference.");
    out.line("// Optional: when omitted, InvokeEndpoint is granted account-wide and the");
    out.line("// handler errors at runtime until an endpoint name is supplied.");
    out.line("sagemakerEndpointName?: string;");
  }
  out.pop();
  out.line("}");
  out.blank();

  out.line("// Complete infrastructure for one region (deploy to each region for");
  out.line("// active-active). Per-slice handlers live at the entry paths referenced");
  out.line("// below; regenerate a slice with the AWS (CDK/TS) button to fill them in.");
  out.line("export class RegionalStack extends cdk.Stack {");
  out.push();
  out.line("constructor(scope: Construct, id: string, props: RegionalStackProps) {");
  out.push();
  out.line("super(scope, id, props);");
  out.blank();

  // Networking
  out.line("// ── Networking (Multi-AZ) ──");
  out.line("const vpc = new ec2.Vpc(this, 'Vpc', {");
  out.push();
  out.line("maxAzs: 3,");
  out.line(minimal ? "natGateways: 1," : "natGateways: 3,");
  out.line("subnetConfiguration: [");
  out.push();
  out.line("{ cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },");
  out.line("{ cidrMask: 24, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },");
  out.pop();
  out.line("],");
  out.pop();
  out.line("});");
  out.blank();
  out.line("const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {");
  out.push();
  out.line("vpc, description: 'Lambda functions security group', allowAllOutbound: true,");
  out.pop();
  out.line("});");
  out.line("const redisSg = new ec2.SecurityGroup(this, 'RedisSg', {");
  out.push();
  out.line("vpc, description: 'ElastiCache Redis security group', allowAllOutbound: false,");
  out.pop();
  out.line("});");
  out.line("redisSg.addIngressRule(lambdaSg, ec2.Port.tcp(6379), 'Lambda to Redis');");
  out.blank();

  // Kinesis
  out.line("// ── Event distribution — regional Kinesis stream ──");
  out.line("const stream = new kinesis.Stream(this, 'EventStream', {");
  out.push();
  out.line("streamName: `" + resourcePrefix + "-events-${props.regionLabel}`,");
  out.line("shardCount: 2,");
  out.line("retentionPeriod: cdk.Duration.hours(168),");
  out.pop();
  out.line("});");
  out.blank();

  // Redis
  out.line("// ── Read model — Multi-AZ ElastiCache Redis ──");
  out.line("const subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {");
  out.push();
  out.line("description: `Redis subnet group - ${props.regionLabel}`,");
  out.line("subnetIds: vpc.privateSubnets.map((s) => s.subnetId),");
  out.line("cacheSubnetGroupName: `" + resourcePrefix + "-redis-${props.regionLabel}`,");
  out.pop();
  out.line("});");
  out.line("const redisReplicationGroup = new elasticache.CfnReplicationGroup(this, 'RedisCluster', {");
  out.push();
  out.line("replicationGroupDescription: `" + ResourcePrefix + " read model - ${props.regionLabel}`,");
  out.line("engine: 'redis',");
  out.line("engineVersion: '7.1',");
  out.line(minimal ? "cacheNodeType: 'cache.t4g.micro'," : "cacheNodeType: 'cache.r7g.large',");
  out.line("numNodeGroups: 1,");
  out.line(minimal ? "replicasPerNodeGroup: 0," : "replicasPerNodeGroup: 2,");
  out.line(minimal ? "automaticFailoverEnabled: false," : "automaticFailoverEnabled: true,");
  out.line(minimal ? "multiAzEnabled: false," : "multiAzEnabled: true,");
  out.line("cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName,");
  out.line("securityGroupIds: [redisSg.securityGroupId],");
  out.line("atRestEncryptionEnabled: true,");
  out.line("transitEncryptionEnabled: true,");
  out.line("autoMinorVersionUpgrade: true,");
  out.line("replicationGroupId: `" + resourcePrefix + "-cache-${props.regionLabel}`,");
  out.pop();
  out.line("});");
  out.line("redisReplicationGroup.addDependency(subnetGroup);");
  out.line("const redisEndpoint = redisReplicationGroup.attrPrimaryEndPointAddress;");
  out.line("const redisPort = redisReplicationGroup.attrPrimaryEndPointPort;");
  out.blank();

  // Common Lambda props
  out.line("// ── Compute — Lambda (ARM64, X-Ray) ──");
  out.line("const commonProps: Partial<nodejs.NodejsFunctionProps> = {");
  out.push();
  out.line("runtime: lambda.Runtime.NODEJS_20_X,");
  out.line("architecture: lambda.Architecture.ARM_64,");
  out.line("memorySize: 512,");
  out.line("tracing: lambda.Tracing.ACTIVE,");
  out.line("bundling: { minify: true, sourceMap: true, target: 'es2022' },");
  out.pop();
  out.line("};");
  out.blank();

  if (hasCommand) {
    // Compute the DCB tag axes across every command in the model — each needs a
    // GSI (partition key tag_<axis>, sort key seq) on the event table so a
    // boundary branch can be queried by tag value.
    const dcbAxes = new Set();
    for (const el of model.elements) {
      if (el.kind !== "command") continue;
      for (const a of axesOf(el)) dcbAxes.add(a);
    }
    const axisList = [...dcbAxes];
    out.line("// ── DCB event-store indexes (required on props.globalTable) ─────────");
    out.line("// A Dynamic Consistency Boundary is queried by tag value, so the event");
    out.line("// table must expose one GSI per tag axis used across the model:");
    if (axisList.length) {
      for (const a of axisList) {
        out.line(`//   • gsi_${a}: partitionKey = 'tag_${a}' (string), sortKey = 'seq' (string)`);
      }
    } else {
      out.line("//   • (no tag axes declared in this model)");
    }
    out.line("// The table's own key schema is: partitionKey = 'eventId' (string),");
    out.line("// sortKey = 'seq' (string). Guard items reuse it: eventId = 'TAGPOS#<axis>#<value>',");
    out.line("// seq = 'POS'. Declare these GSIs where props.globalTable is created; add");
    out.line("// them with addGlobalSecondaryIndex(...) if the table is defined in this app:");
    if (axisList.length) {
      out.line("/*");
      for (const a of axisList) {
        out.line(`  props.globalTable.addGlobalSecondaryIndex({`);
        out.line(`    indexName: 'gsi_${a}',`);
        out.line(`    partitionKey: { name: 'tag_${a}', type: dynamodb.AttributeType.STRING },`);
        out.line(`    sortKey: { name: 'seq', type: dynamodb.AttributeType.STRING },`);
        out.line(`    projectionType: dynamodb.ProjectionType.ALL,`);
        out.line(`  });`);
      }
      out.line("*/");
    }
    out.blank();
    out.line("// Command handler (write side) — EVENT_TABLE_NAME + Kinesis, grants R/W.");
    out.line("// grantReadWriteData covers Query on the table + its GSIs and");
    out.line("// TransactWriteItems (the DCB conditional append).");
    out.line("const commandHandler = new nodejs.NodejsFunction(this, 'CommandHandler', {");
    out.push();
    out.line("...commonProps,");
    out.line("entry: path.join(__dirname, '../../src/commands/handler.ts'),");
    out.line("handler: 'handler',");
    out.line("functionName: `" + resourcePrefix + "-command-${props.regionLabel}`,");
    out.line("timeout: cdk.Duration.seconds(10),");
    out.line("environment: {");
    out.push();
    out.line("EVENT_TABLE_NAME: props.globalTable.tableName,");
    out.line("KINESIS_STREAM_NAME: stream.streamName,");
    if (hasAutomation) {
      out.line("// SageMaker endpoint invoked by automation slices for inference.");
      out.line("// Provide the deployed endpoint name via the SAGEMAKER_ENDPOINT_NAME");
      out.line("// context/env; empty until an endpoint exists (the handler then errors).");
      out.line("SAGEMAKER_ENDPOINT_NAME: props.sagemakerEndpointName ?? '',");
    }
    out.pop();
    out.line("},");
    out.pop();
    out.line("});");
    out.line("props.globalTable.grantReadWriteData(commandHandler);");
    out.line("stream.grantWrite(commandHandler);");
    if (hasAutomation) {
      out.blank();
      out.line("// Allow the command Lambda to invoke the model endpoint. Scoped to a");
      out.line("// named endpoint when provided, else to any endpoint in this account.");
      out.line("commandHandler.addToRolePolicy(new iam.PolicyStatement({");
      out.push();
      out.line("actions: ['sagemaker:InvokeEndpoint'],");
      out.line("resources: [props.sagemakerEndpointName");
      out.push();
      out.line("? `arn:aws:sagemaker:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:endpoint/${props.sagemakerEndpointName}`");
      out.line(": `arn:aws:sagemaker:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:endpoint/*`],");
      out.pop();
      out.pop();
      out.line("}));");
    }
    out.blank();
  }

  if (hasReadModel) {
    out.line("// Query handler (read side) — reads Redis only, in the VPC.");
    out.line("const queryHandler = new nodejs.NodejsFunction(this, 'QueryHandler', {");
    out.push();
    out.line("...commonProps,");
    out.line("entry: path.join(__dirname, '../../src/queries/handler.ts'),");
    out.line("handler: 'handler',");
    out.line("functionName: `" + resourcePrefix + "-query-${props.regionLabel}`,");
    out.line("timeout: cdk.Duration.seconds(5),");
    out.line("vpc,");
    out.line("vpcSubnets: { subnets: vpc.privateSubnets },");
    out.line("securityGroups: [lambdaSg],");
    out.line("environment: { REDIS_HOST: redisEndpoint, REDIS_PORT: redisPort, REDIS_TLS: 'true' },");
    out.pop();
    out.line("});");
    out.blank();

    out.line("// Projector (read side) — DynamoDB Streams → Redis, in the VPC.");
    out.line("const projectorHandler = new nodejs.NodejsFunction(this, 'ProjectorHandler', {");
    out.push();
    out.line("...commonProps,");
    out.line("entry: path.join(__dirname, '../../src/projector/handler.ts'),");
    out.line("handler: 'handler',");
    out.line("functionName: `" + resourcePrefix + "-projector-${props.regionLabel}`,");
    out.line("timeout: cdk.Duration.seconds(30),");
    out.line("vpc,");
    out.line("vpcSubnets: { subnets: vpc.privateSubnets },");
    out.line("securityGroups: [lambdaSg],");
    out.line("environment: { REDIS_HOST: redisEndpoint, REDIS_PORT: redisPort, REDIS_TLS: 'true' },");
    out.pop();
    out.line("});");
    out.line("props.globalTable.grantStreamRead(projectorHandler);");
    out.line("// Primary region owns the stream→projector mapping (cross-region stream");
    out.line("// mapping is configured post-deploy).");
    out.line("if (props.isPrimary) {");
    out.push();
    out.line("projectorHandler.addEventSource(");
    out.push();
    out.line("new eventsources.DynamoEventSource(props.globalTable, {");
    out.push();
    out.line("startingPosition: lambda.StartingPosition.TRIM_HORIZON,");
    out.line("batchSize: 25,");
    out.line("retryAttempts: 5,");
    out.line("bisectBatchOnError: true,");
    out.pop();
    out.line("})");
    out.pop();
    out.line(");");
    out.pop();
    out.line("}");
    out.blank();
  }

  // API Gateway + routes
  out.line("// ── API Gateway (prod stage, throttled, CORS) ──");
  out.line("const api = new apigateway.RestApi(this, '" + ResourcePrefix + "Api', {");
  out.push();
  out.line("restApiName: `" + ResourcePrefix + " API (${props.regionLabel})`,");
  out.line("deployOptions: {");
  out.push();
  out.line("stageName: 'prod',");
  out.line("tracingEnabled: true,");
  out.line("metricsEnabled: true,");
  out.line("throttlingRateLimit: 1000,");
  out.line("throttlingBurstLimit: 2000,");
  out.pop();
  out.line("},");
  out.line("defaultCorsPreflightOptions: {");
  out.push();
  out.line("allowOrigins: apigateway.Cors.ALL_ORIGINS,");
  out.line("allowMethods: apigateway.Cors.ALL_METHODS,");
  out.pop();
  out.line("},");
  out.pop();
  out.line("});");
  out.blank();
  out.line("const apiResource = api.root.addResource('api');");
  out.line("const recordsResource = apiResource.addResource('" + apiPath + "');");
  if (hasCommand) {
    out.line("recordsResource.addMethod('POST', new apigateway.LambdaIntegration(commandHandler));");
  }
  if (hasReadModel) {
    out.line("recordsResource.addMethod('GET', new apigateway.LambdaIntegration(queryHandler));");
    out.line("const recordByIdResource = recordsResource.addResource('{id}');");
    out.line("recordByIdResource.addMethod('GET', new apigateway.LambdaIntegration(queryHandler));");
  }
  out.pop();
  out.line("}");
  out.pop();
  out.line("}");
  out.blank();
}

// ─────────────────────────────────────────────────────────────────────────
// AWS-native public API
// ─────────────────────────────────────────────────────────────────────────

// Generate the model-level shared CDK infra (regional-stack.ts) as live code.
// tier: 'production' (default) or 'minimal' (low-cost demo footprint).
function generateAwsInfra({ model, sliceName, tier = "production" }) {
  const out = new Emitter();
  const parts = partition(model);
  const name = sliceName || "model";
  genAwsRegionalStack(out, model, parts, name, tier);
  return out.toString();
}

// ─────────────────────────────────────────────────────────────────────────
// AWS-native public API
// ─────────────────────────────────────────────────────────────────────────

// Header for the shared-runtime (model-level) output.
function genAwsSharedHeader(out, modelName) {
  out.line("// ─────────────────────────────────────────────────────────────");
  out.line(`// Shared runtime for model: ${modelName}`);
  out.line("// Target: AWS-native (CDK + Lambda, TypeScript)");
  out.line("// The COMMON part — emitted once from the whole model. Contains the");
  out.line("// stored-event envelope, the merged EventTypes map, the createEvent");
  out.line("// factory, the DynamoDB/Kinesis/Redis runtime, and the shared CDK infra.");
  out.line("// Each slice imports from './shared/event-store' instead of re-emitting it.");
  out.line("// Source of truth is the model .md — regenerate, don't hand-edit.");
  out.line("// ─────────────────────────────────────────────────────────────");
  out.blank();
}

// Emit the per-slice import of the shared runtime symbols.
function genAwsSliceImports(out, parts) {
  const names = awsSharedImports(parts);
  out.line(`import { ${names.join(", ")} } from ${tsStr(AWS_SHARED_MODULE)};`);
  out.blank();
}

// Generate the model-level shared runtime (src/shared/event-store.ts). Pure
// runtime only — the CDK infra is a separate 'infra' part (regional-stack.ts).
function generateAwsShared({ model, sliceName }) {
  const out = new Emitter();
  const parts = partition(model);
  const allEvents = [...parts.domainEvent, ...parts.externalEvent];
  const name = sliceName || "model";
  genAwsSharedHeader(out, name);
  genAwsSharedEventTypes(out, allEvents);
  genAwsSharedRuntime(out);
  genAwsSharedInfra(out, allEvents); // now just a pointer note to the infra part
  return out.toString();
}

/**
 * Generate AWS-native TypeScript (CDK + Lambda) from an already-parsed model.
 *
 * Two parts, decoupled:
 *   - part: 'runtime' — the COMMON runtime, emitted once from the whole model:
 *       the DomainEvent envelope, the merged EventTypes map, createEvent, and
 *       the DynamoDB/Kinesis/Redis helpers (src/shared/event-store.ts).
 *   - part: 'infra' — the COMMON CDK stack, emitted once from the whole model:
 *       the VPC, DynamoDB global-table reference, Kinesis stream, ElastiCache
 *       Redis, the command/query/projector Lambdas, and the API Gateway
 *       (infra/stacks/regional-stack.ts) — live, compilable CDK.
 *   - part: 'slice' (default) — ONLY this slice's own code: its command/event
 *       interfaces, the aggregate (rehydrate/applyEvent/validateCommand), the
 *       route handler, and the CDK fragment — importing the shared runtime.
 *
 * @param {object} args
 * @param {object} args.model  parsed eventModel (parseEventModel output)
 * @param {object} args.tests  parsed sliceTests (parseSliceTests output)
 * @param {string} [args.sliceName]  human name for the header comment
 * @param {Array}  [args.decidedExclusions]
 * @param {('runtime'|'infra'|'slice')} [args.part='slice']
 * @param {('production'|'minimal')} [args.tier='production']  infra cost tier
 * @returns {string} TypeScript source
 */
export function generateAwsNative({ model, tests, sliceName, decidedExclusions = [], part = "slice", tier = "production" }) {
  if (part === "runtime") {
    return generateAwsShared({ model, sliceName });
  }
  if (part === "infra") {
    return generateAwsInfra({ model, sliceName, tier });
  }
  if (part === "projection") {
    // Model-level read side: one projector + query over EVERY read model in
    // the model (not a single slice). Partition the whole model, then drop
    // commands so the projection path runs across all read models and folds
    // each source event into its own read model.
    const out = new Emitter();
    const parts = partition(model);
    parts.command = [];
    genAwsHeader(out, sliceName || "views");
    genAwsSliceImports(out, parts);
    genAwsInterfaces(out, parts);
    genAwsProjection(out, parts, model);
    return out.toString();
  }

  const out = new Emitter();
  const parts = partition(model);
  const producedByCommand = producedByCommandMap(model, parts);

  const name =
    sliceName ||
    (model.slices && model.slices[0] && (model.slices[0].label || model.slices[0].id)) ||
    "slice";

  genAwsHeader(out, name);
  genAwsUnmappedAndExclusions(out, parts, producedByCommand, decidedExclusions);
  // The slice imports the common runtime instead of re-emitting the envelope,
  // EventTypes, createEvent, and the event-store/Kinesis/Redis helpers.
  genAwsSliceImports(out, parts);
  genAwsInterfaces(out, parts);
  genAwsAggregate(out, parts, model, tests);

  const madeHandler = genAwsCommandHandler(out, parts, model);
  if (!madeHandler) genAwsProjection(out, parts, model);

  genAwsCdk(out, parts, name);

  return out.toString();
}

/**
 * Convenience: generate AWS-native TypeScript directly from a slice `.md`
 * (or raw DSL) string. Mirrors generateFromSource for the Java target.
 *
 * When the source is the whole model (the `__model` view) or `opts.part` is
 * 'runtime', this emits the shared runtime. Otherwise it emits just the slice.
 *
 * @param {string} src  slice spec markdown or raw DSL
 * @param {object} [opts]
 * @param {string} [opts.sliceName]
 * @param {('runtime'|'infra'|'slice')} [opts.part]  force a part; otherwise inferred
 * @param {('production'|'minimal')} [opts.tier]  infra cost tier (part='infra')
 * @returns {string} TypeScript source
 */
export function generateAwsFromSource(src, opts = {}) {
  const model = parseEventModel(src);
  const tests = parseSliceTests(src);
  const decidedExclusions = parseDecidedExclusions(src);
  // Infer: a source declaring more than one slice is the whole model → runtime.
  const part =
    opts.part || ((model.slices && model.slices.length > 1) ? "runtime" : "slice");
  return generateAwsNative({
    model,
    tests,
    sliceName: opts.sliceName,
    decidedExclusions,
    part,
    tier: opts.tier || "production",
  });
}
