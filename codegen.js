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

  // command core (first command, if any)
  const cmd = parts.command[0] || null;
  const commandCore = cmd
    ? { name: typeNameFor(cmd), fields: (cmd.fields || []).map((f) => f.name) }
    : null;

  // boundary: union of reads + the axes used
  const boundary = cmd
    ? {
        tags: axesOf(cmd),
        reads: (cmd.reads || []).map((id) => storedName(id)),
      }
    : null;

  // emitted events with their pinned stored names
  const emittedIds = cmd ? producedByCommand.get(cmd.id) || [] : [];
  const emitList = (emittedIds.length
    ? emittedIds
    : [...parts.domainEvent].map((e) => e.id)
  ).map((id) => ({ name: pascal(id), storedAs: storedName(id) }));

  const unmapped = detectUnmapped(parts, producedByCommand, decidedExclusions);

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

  out.line("// ── Aggregate — state is never stored; it is folded from events ─────");
  out.line("// rehydrate() replays the event stream; validateCommand() enforces the");
  out.line("// slice's business rules. This is the pure core of the write side.");
  out.line("export interface AggregateState {");
  out.push();
  out.line("aggregateId: string;");
  out.line("status: string | null;");
  for (const [name, ty] of stateFields) {
    if (name === "aggregateId" || name === "status" || name === "version") continue;
    out.line(`${name}?: ${ty};`);
  }
  out.line("version: number;");
  out.pop();
  out.line("}");
  out.blank();

  out.line("export function rehydrate(events: DomainEvent[]): AggregateState {");
  out.push();
  out.line("let state: AggregateState = { aggregateId: '', status: null, version: 0 };");
  out.line("for (const event of events) state = applyEvent(state, event);");
  out.line("return state;");
  out.pop();
  out.line("}");
  out.blank();

  // applyEvent: one case per event the command(s) read (the events that shape
  // state). Fold each event's fields into state; status is left as a TODO the
  // lifecycle rules drive.
  out.line("function applyEvent(state: AggregateState, event: DomainEvent): AggregateState {");
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
    out.line("aggregateId: event.aggregateId,");
    out.line(`// TODO: set the status this event transitions to (e.g. '${constant(ev.id)}').`);
    out.line(`status: state.status,`);
    for (const f of ev.fields || []) {
      if (f.axis) continue; // identity/axis fields keyed separately
      out.line(`${camel(f.name)}: event.payload.${camel(f.name)} as ${tsType(f.type)},`);
    }
    out.line("version: event.version,");
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
  out.line("state: AggregateState,");
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
  const primary = cmds[0];
  const axis = axesOf(primary)[0] || null;

  out.line("// ── Command Lambda (write side) ─────────────────────────────────────");
  out.line("// API Gateway → this handler. The DCB `reads` boundary becomes a");
  out.line("// DynamoDB query keyed by aggregateId; the new event is persisted with");
  out.line("// optimistic concurrency (version) and published to Kinesis. The event");
  out.line("// store, Kinesis, and response helpers come from the shared runtime.");
  out.line("import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';");
  out.line("import { v4 as uuidv4 } from 'uuid';");
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
  cmds.forEach((cmd) => {
    out.line(`// Route: handle ${tsStr(cmd.label)}`);
    out.line(`return handle${typeNameFor(cmd)}(event, body);`);
  });
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

  cmds.forEach((cmd) => {
    const cmdType = typeNameFor(cmd);
    const produced = producedByCommand.get(cmd.id) || [];
    const emitted = produced.length ? produced : parts.domainEvent.map((e) => e.id);
    const firstEvent = emitted[0] || null;
    const isCreation = (cmd.reads || []).length === 0;
    const cmdAxis = axesOf(cmd)[0] || axis;

    out.line(`async function handle${cmdType}(`);
    out.push();
    out.line("event: APIGatewayProxyEvent,");
    out.line("body: Record<string, unknown>");
    out.pop();
    out.line("): Promise<APIGatewayProxyResult> {");
    out.push();

    // Command fields available to build the event payload (axis-tag fields
    // are keyed separately, so they are excluded from the payload set).
    const cmdFields = (cmd.fields || []).filter((f) => !f.axis);
    // For a non-creation command the routing id (the axis field, e.g. loanId)
    // is bound from the path/body as its own `const`, so it must NOT also be
    // destructured here — that would redeclare the same block-scoped variable.
    const routingName = !isCreation && cmdAxis ? camel(cmdAxis) : null;
    const destructured = cmdFields.filter((f) => camel(f.name) !== routingName);
    if (destructured.length) {
      out.line(`const { ${destructured.map((f) => camel(f.name)).join(", ")} } = body as {`);
      out.push();
      for (const f of destructured) out.line(`${camel(f.name)}?: ${tsType(f.type)};`);
      out.pop();
      out.line("};");
    }

    if (isCreation) {
      out.line(`const aggregateId = uuidv4();`);
      out.line("const version = 1;");
      if (firstEvent) {
        out.line(`const domainEvent = createEvent(aggregateId, version, EventTypes.${eventTypeKey(firstEvent)}, {`);
        out.push();
        const ev = [...parts.domainEvent, ...parts.externalEvent].find((e) => e.id === firstEvent);
        for (const f of (ev && ev.fields) || []) {
          if (f.axis) continue;
          out.line(`${camel(f.name)}: ${cmdFields.some((c) => c.name === f.name) ? camel(f.name) : `body.${camel(f.name)}`},`);
        }
        out.pop();
        out.line("});");
      } else {
        out.line("const domainEvent = createEvent(aggregateId, version, 'TODO', body);");
      }
    } else {
      // Route id from the axis (e.g. loanId in the path), then load + replay.
      const idVar = cmdAxis ? camel(cmdAxis) : "aggregateId";
      out.line(`// The aggregate id (DCB routing axis${cmdAxis ? " '" + cmdAxis + "'" : ""}) identifies the stream to load.`);
      out.line(`const ${idVar} = event.pathParameters?.id ?? String(body.${idVar} ?? '');`);
      out.line(`if (!${idVar}) return response(400, { error: '${idVar} is required' });`);
      out.line(`const events = await loadEvents(${idVar});`);
      out.line("if (events.length === 0) return response(404, { error: 'Aggregate not found' });");
      out.line("const state = rehydrate(events);");
      out.blank();
      out.line("// Enforce business rules against the replayed state.");
      out.line(`const validationError = validateCommand(state, ${tsStr(cmdType)});`);
      out.line("if (validationError) return response(409, { error: validationError });");
      out.blank();
      out.line("const version = state.version + 1;");
      if (firstEvent) {
        out.line(`const domainEvent = createEvent(${idVar}, version, EventTypes.${eventTypeKey(firstEvent)}, {`);
        out.push();
        const ev = [...parts.domainEvent, ...parts.externalEvent].find((e) => e.id === firstEvent);
        for (const f of (ev && ev.fields) || []) {
          if (f.axis) continue;
          out.line(`${camel(f.name)}: ${cmdFields.some((c) => c.name === f.name) ? camel(f.name) : `body.${camel(f.name)}`},`);
        }
        out.pop();
        out.line("});");
      } else {
        out.line(`const domainEvent = createEvent(${idVar}, version, 'TODO', body);`);
      }
    }
    out.blank();
    out.line("await persistEvent(domainEvent);");
    out.line("await publishToKinesis(domainEvent);");
    out.line(`return response(${isCreation ? "201" : "200"}, { ${cmdAxis ? camel(cmdAxis) + ": domainEvent.aggregateId, " : ""}version });`);
    out.pop();
    out.line("}");
    out.blank();
  });

  // loadEvents / persistEvent / publishToKinesis / response are imported from
  // the shared runtime — this file carries only the slice-specific logic.
  return true;
}

// The projector Lambda + query Lambda for a view slice (no command). Mirrors
// projector/handler.ts (DynamoDB Streams → ioredis) and queries/handler.ts.
function genAwsProjection(out, parts, model) {
  if (parts.command.length > 0) return false;
  const readModels = parts.readModel;
  if (readModels.length === 0) return false;
  const rm = readModels[0];
  const sources = sourceEventsFor(model, parts, rm.id);
  const knownEvents = new Map([...parts.domainEvent, ...parts.externalEvent].map((e) => [e.id, e]));
  const view = typeNameFor(rm);

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

  const keyPrefix = camel(rm.id);
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
  out.line("const { aggregateId, eventType, timestamp, payload } = item;");
  out.line("switch (eventType) {");
  out.push();
  if (sources.length === 0) {
    out.line("// TODO: no source events wired to this read model in the slice edges.");
  }
  for (const evId of sources) {
    const ev = knownEvents.get(evId);
    out.line(`case EventTypes.${eventTypeKey(evId)}:`);
    out.push();
    out.line(`await on${pascal(evId)}(client, aggregateId, timestamp, payload);`);
    out.line("break;");
    out.pop();
  }
  out.line("default:");
  out.push();
  out.line("console.warn(`Unknown event type: ${eventType}`);");
  out.pop();
  out.pop();
  out.line("}");
  out.pop();
  out.line("}");
  out.blank();

  // One handler function per source event: write/merge the read-model record.
  for (const evId of sources) {
    const ev = knownEvents.get(evId);
    out.line(`async function on${pascal(evId)}(`);
    out.push();
    out.line("client: Redis,");
    out.line("aggregateId: string,");
    out.line("timestamp: string,");
    out.line("payload: Record<string, unknown>");
    out.pop();
    out.line("): Promise<void> {");
    out.push();
    out.line(`// Merge ${tsStr(ev ? ev.label : evId)} into the ${view} record.`);
    out.line(`const existing = await client.get(\`${keyPrefix}:\${aggregateId}\`);`);
    out.line(`const view: Record<string, unknown> = existing ? JSON.parse(existing) : { ${camel(rm.fields?.find((f) => f.axis)?.name || "id")}: aggregateId };`);
    for (const f of (ev && ev.fields) || []) {
      if (f.axis) continue;
      out.line(`view.${camel(f.name)} = payload.${camel(f.name)};`);
    }
    out.line("// TODO: set view.status to the status this event transitions to.");
    out.line(`const pipeline = client.pipeline();`);
    out.line(`pipeline.set(\`${keyPrefix}:\${aggregateId}\`, JSON.stringify(view));`);
    out.line(`pipeline.zadd('${keyPrefix}:all', Date.parse(timestamp).toString(), aggregateId);`);
    out.line("await pipeline.exec();");
    out.pop();
    out.line("}");
    out.blank();
  }

  // ── Query Lambda snippet (read the Redis read model behind a GET route).
  out.line("// ── Query Lambda (read side) — serves GET from the Redis read model ──");
  out.line("// Reads the projection only; never touches the event store. This is the");
  out.line("// query half of CQRS (e.g. GET /api/" + keyPrefix + "/{id}).");
  out.line("export async function queryHandler(");
  out.push();
  out.line("event: APIGatewayProxyEvent");
  out.pop();
  out.line("): Promise<APIGatewayProxyResult> {");
  out.push();
  out.line("const client = getRedis();");
  out.line("const id = event.pathParameters?.id;");
  out.line("if (id) {");
  out.push();
  out.line(`const data = await client.get(\`${keyPrefix}:\${id}\`);`);
  out.line("if (!data) return response(404, { error: 'Not found' });");
  out.line("return response(200, JSON.parse(data));");
  out.pop();
  out.line("}");
  out.line(`const ids = await client.zrevrange('${keyPrefix}:all', 0, 49);`);
  out.line("if (ids.length === 0) return response(200, []);");
  out.line("const pipeline = client.pipeline();");
  out.line(`for (const key of ids) pipeline.get(\`${keyPrefix}:\${key}\`);`);
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

// CDK constructs (regional-stack.ts style) for this slice: the event-table
// reference, the NodejsFunction(s) wired with env + grants, and the API
// Gateway route (command slice) or the DynamoDB Streams event source +
// query route (view slice).
function genAwsCdk(out, parts, sliceName) {
  const isCommand = parts.command.length > 0;
  const isView = !isCommand && parts.readModel.length > 0;
  if (!isCommand && !isView) return;

  const base = pascal((sliceName || "slice").replace(/\.md$/, ""));
  out.line("// ═══════════════════════════════════════════════════════════════════");
  out.line("// CDK wiring (regional-stack.ts style). Drop these constructs into the");
  out.line("// RegionalStack constructor; they reference shared infra (event table,");
  out.line("// stream, VPC, Redis) already declared there.");
  out.line("// ═══════════════════════════════════════════════════════════════════");
  out.line("//");
  out.line("// import * as cdk from 'aws-cdk-lib';");
  out.line("// import * as lambda from 'aws-cdk-lib/aws-lambda';");
  out.line("// import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';");
  out.line("// import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';");
  out.line("// import * as apigateway from 'aws-cdk-lib/aws-apigateway';");
  out.line("// import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';");
  out.line("// import * as path from 'path';");
  out.line("//");

  if (isCommand) {
    out.line(`// const ${camel(base)}Command = new nodejs.NodejsFunction(this, '${base}Command', {`);
    out.line("//   runtime: lambda.Runtime.NODEJS_20_X,");
    out.line("//   architecture: lambda.Architecture.ARM_64,");
    out.line(`//   entry: path.join(__dirname, '../../src/${camel(base)}/handler.ts'),`);
    out.line("//   handler: 'handler',");
    out.line("//   timeout: cdk.Duration.seconds(10),");
    out.line("//   environment: {");
    out.line("//     EVENT_TABLE_NAME: 'LoanEvents',");
    out.line("//     KINESIS_STREAM_NAME: stream.streamName,");
    out.line("//   },");
    out.line("// });");
    out.line(`// // Grants: read+write the event store, publish to Kinesis.`);
    out.line(`// props.globalTable.grantReadWriteData(${camel(base)}Command);`);
    out.line(`// stream.grantWrite(${camel(base)}Command);`);
    out.line("//");
    out.line(`// // API Gateway route → the command handler.`);
    out.line(`// const ${camel(base)}Integration = new apigateway.LambdaIntegration(${camel(base)}Command);`);
    for (const cmd of parts.command) {
      const axis = axesOf(cmd)[0];
      if ((cmd.reads || []).length === 0) {
        out.line(`// api.root.addResource('api').addResource('${camel(pascal(cmd.id))}s').addMethod('POST', ${camel(base)}Integration);`);
      } else {
        out.line(`// // POST /api/${camel(pascal(cmd.id))}s/{id} (routing axis: ${axis || "id"})`);
        out.line(`// loanByIdResource.addResource('${camel(pascal(cmd.id))}').addMethod('POST', ${camel(base)}Integration);`);
      }
    }
  } else {
    // View slice: projector wired to DynamoDB Streams + query route.
    out.line(`// const ${camel(base)}Projector = new nodejs.NodejsFunction(this, '${base}Projector', {`);
    out.line("//   runtime: lambda.Runtime.NODEJS_20_X,");
    out.line("//   architecture: lambda.Architecture.ARM_64,");
    out.line(`//   entry: path.join(__dirname, '../../src/${camel(base)}/projector.ts'),`);
    out.line("//   handler: 'handler',");
    out.line("//   timeout: cdk.Duration.seconds(30),");
    out.line("//   vpc, vpcSubnets: { subnets: vpc.privateSubnets }, securityGroups: [lambdaSg],");
    out.line("//   environment: { REDIS_HOST: redisEndpoint, REDIS_PORT: redisPort, REDIS_TLS: 'true' },");
    out.line("// });");
    out.line(`// // DynamoDB Streams → projector (rebuilds the read model from events).`);
    out.line(`// props.globalTable.grantStreamRead(${camel(base)}Projector);`);
    out.line(`// ${camel(base)}Projector.addEventSource(new eventsources.DynamoEventSource(props.globalTable, {`);
    out.line("//   startingPosition: lambda.StartingPosition.TRIM_HORIZON,");
    out.line("//   batchSize: 25, retryAttempts: 5, bisectBatchOnError: true,");
    out.line("// }));");
    out.line("//");
    out.line(`// const ${camel(base)}Query = new nodejs.NodejsFunction(this, '${base}Query', {`);
    out.line("//   runtime: lambda.Runtime.NODEJS_20_X,");
    out.line("//   architecture: lambda.Architecture.ARM_64,");
    out.line(`//   entry: path.join(__dirname, '../../src/${camel(base)}/handler.ts'),`);
    out.line("//   handler: 'queryHandler',");
    out.line("//   timeout: cdk.Duration.seconds(5),");
    out.line("//   vpc, vpcSubnets: { subnets: vpc.privateSubnets }, securityGroups: [lambdaSg],");
    out.line("//   environment: { REDIS_HOST: redisEndpoint, REDIS_PORT: redisPort, REDIS_TLS: 'true' },");
    out.line("// });");
    const rm = parts.readModel[0];
    out.line(`// // GET /api/${camel(rm.id)}/{id} → the query handler (reads Redis only).`);
    out.line(`// const ${camel(base)}Integration = new apigateway.LambdaIntegration(${camel(base)}Query);`);
    out.line(`// const ${camel(rm.id)}Resource = api.root.addResource('api').addResource('${camel(rm.id)}');`);
    out.line(`// ${camel(rm.id)}Resource.addMethod('GET', ${camel(base)}Integration);`);
    out.line(`// ${camel(rm.id)}Resource.addResource('{id}').addMethod('GET', ${camel(base)}Integration);`);
  }
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
  const base = ["DomainEvent", "EventTypes", "createEvent", "response"];
  if (isCommand) {
    return [...base, "loadEvents", "persistEvent", "publishToKinesis"];
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
  out.line("import { DynamoDBDocumentClient, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';");
  out.line("import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';");
  out.line("import Redis from 'ioredis';");
  out.blank();
  out.line("const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));");
  out.line("const kinesis = new KinesisClient({});");
  out.line("const TABLE_NAME = process.env.EVENT_TABLE_NAME!;");
  out.line("const STREAM_NAME = process.env.KINESIS_STREAM_NAME!;");
  out.blank();

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

  out.line("// Load an aggregate's full event stream (oldest first) for replay.");
  out.line("export async function loadEvents(aggregateId: string): Promise<DomainEvent[]> {");
  out.push();
  out.line("const result = await dynamodb.send(");
  out.push();
  out.line("new QueryCommand({");
  out.push();
  out.line("TableName: TABLE_NAME,");
  out.line("KeyConditionExpression: 'aggregateId = :id',");
  out.line("ExpressionAttributeValues: { ':id': aggregateId },");
  out.line("ScanIndexForward: true, // oldest first");
  out.pop();
  out.line("})");
  out.pop();
  out.line(");");
  out.line("return (result.Items || []) as DomainEvent[];");
  out.pop();
  out.line("}");
  out.blank();

  out.line("// Persist a new event with optimistic concurrency on (aggregateId, version).");
  out.line("export async function persistEvent(domainEvent: DomainEvent): Promise<void> {");
  out.push();
  out.line("await dynamodb.send(");
  out.push();
  out.line("new PutCommand({");
  out.push();
  out.line("TableName: TABLE_NAME,");
  out.line("Item: domainEvent,");
  out.line("ConditionExpression: 'attribute_not_exists(aggregateId) AND attribute_not_exists(version)',");
  out.pop();
  out.line("})");
  out.pop();
  out.line(");");
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
  out.line("PartitionKey: domainEvent.aggregateId,");
  out.line("Data: Buffer.from(JSON.stringify(domainEvent)),");
  out.pop();
  out.line("})");
  out.pop();
  out.line(");");
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
function genAwsRegionalStack(out, model, parts, modelName) {
  const hasCommand = parts.command.length > 0 || model.elements.some((e) => e.kind === "command");
  const hasReadModel = parts.readModel.length > 0 || model.elements.some((e) => e.kind === "readModel");

  out.line("// ─────────────────────────────────────────────────────────────");
  out.line(`// Shared infrastructure for model: ${modelName}`);
  out.line("// Target: AWS-native CDK — infra/stacks/regional-stack.ts");
  out.line("// The COMMON stack, emitted once from the whole model: Multi-AZ VPC,");
  out.line("// the DynamoDB global-table reference, a regional Kinesis stream, a");
  out.line("// Multi-AZ ElastiCache Redis replication group, the command/query/");
  out.line("// projector Lambdas, and the API Gateway. Deployed identically per region");
  out.line("// for active-active. Source of truth is the model .md — regenerate.");
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
  out.line("import { Construct } from 'constructs';");
  out.line("import * as path from 'path';");
  out.blank();

  out.line("export interface RegionalStackProps extends cdk.StackProps {");
  out.push();
  out.line("regionLabel: string;");
  out.line("globalTable: dynamodb.Table;");
  out.line("isPrimary: boolean;");
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
  out.line("natGateways: 3,");
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
  out.line("streamName: `loan-events-${props.regionLabel}`,");
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
  out.line("cacheSubnetGroupName: `loan-redis-${props.regionLabel}`,");
  out.pop();
  out.line("});");
  out.line("const redisReplicationGroup = new elasticache.CfnReplicationGroup(this, 'RedisCluster', {");
  out.push();
  out.line("replicationGroupDescription: `Loan read model - ${props.regionLabel}`,");
  out.line("engine: 'redis',");
  out.line("engineVersion: '7.1',");
  out.line("cacheNodeType: 'cache.r7g.large',");
  out.line("numNodeGroups: 1,");
  out.line("replicasPerNodeGroup: 2,");
  out.line("automaticFailoverEnabled: true,");
  out.line("multiAzEnabled: true,");
  out.line("cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName,");
  out.line("securityGroupIds: [redisSg.securityGroupId],");
  out.line("atRestEncryptionEnabled: true,");
  out.line("transitEncryptionEnabled: true,");
  out.line("autoMinorVersionUpgrade: true,");
  out.line("replicationGroupId: `loan-cache-${props.regionLabel}`,");
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
    out.line("// Command handler (write side) — EVENT_TABLE_NAME + Kinesis, grants R/W.");
    out.line("const commandHandler = new nodejs.NodejsFunction(this, 'CommandHandler', {");
    out.push();
    out.line("...commonProps,");
    out.line("entry: path.join(__dirname, '../../src/commands/handler.ts'),");
    out.line("handler: 'handler',");
    out.line("functionName: `loan-command-${props.regionLabel}`,");
    out.line("timeout: cdk.Duration.seconds(10),");
    out.line("environment: {");
    out.push();
    out.line("EVENT_TABLE_NAME: 'LoanEvents',");
    out.line("KINESIS_STREAM_NAME: stream.streamName,");
    out.pop();
    out.line("},");
    out.pop();
    out.line("});");
    out.line("props.globalTable.grantReadWriteData(commandHandler);");
    out.line("stream.grantWrite(commandHandler);");
    out.blank();
  }

  if (hasReadModel) {
    out.line("// Query handler (read side) — reads Redis only, in the VPC.");
    out.line("const queryHandler = new nodejs.NodejsFunction(this, 'QueryHandler', {");
    out.push();
    out.line("...commonProps,");
    out.line("entry: path.join(__dirname, '../../src/queries/handler.ts'),");
    out.line("handler: 'handler',");
    out.line("functionName: `loan-query-${props.regionLabel}`,");
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
    out.line("functionName: `loan-projector-${props.regionLabel}`,");
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
  out.line("const api = new apigateway.RestApi(this, 'LoanApi', {");
  out.push();
  out.line("restApiName: `Loan API (${props.regionLabel})`,");
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
  out.line("const loansResource = apiResource.addResource('loans');");
  if (hasCommand) {
    out.line("loansResource.addMethod('POST', new apigateway.LambdaIntegration(commandHandler));");
  }
  if (hasReadModel) {
    out.line("loansResource.addMethod('GET', new apigateway.LambdaIntegration(queryHandler));");
    out.line("const loanByIdResource = loansResource.addResource('{id}');");
    out.line("loanByIdResource.addMethod('GET', new apigateway.LambdaIntegration(queryHandler));");
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
function generateAwsInfra({ model, sliceName }) {
  const out = new Emitter();
  const parts = partition(model);
  const name = sliceName || "model";
  genAwsRegionalStack(out, model, parts, name);
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
 * @returns {string} TypeScript source
 */
export function generateAwsNative({ model, tests, sliceName, decidedExclusions = [], part = "slice" }) {
  if (part === "runtime") {
    return generateAwsShared({ model, sliceName });
  }
  if (part === "infra") {
    return generateAwsInfra({ model, sliceName });
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
 * @param {('runtime'|'slice')} [opts.part]  force a part; otherwise inferred
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
  });
}
