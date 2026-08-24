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
