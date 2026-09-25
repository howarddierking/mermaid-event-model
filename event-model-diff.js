// Diff / change visualization between two Event Model versions.
//
// Given an "old" and a "new" model (as DSL source or markdown containing an
// `eventModel` block), this computes a structural diff — which elements,
// edges, lanes, and slices were added, removed, modified, or left unchanged —
// and renders a single diagram of the *union* of both versions, coloured by
// change status. Nothing about the core layout/render pipeline changes: we
// reuse `renderEventModel` to lay everything out, then style the result via a
// DOM overlay (the same post-render approach `applySliceFilter` uses), so the
// two features compose and the layout engine stays the single source of truth.
//
// Usage (browser or Node+jsdom):
//   import { renderModelDiff } from "./event-model-diff.js";
//   const { diff } = renderModelDiff(oldSrc, newSrc, targetEl);
//
// Or compute the diff without rendering:
//   import { computeModelDiff } from "./event-model-diff.js";
//   const diff = computeModelDiff(oldSrc, newSrc);

import { parseEventModel, renderEventModel } from "./event-model.js";

// Change status values, in increasing visual salience.
export const DIFF_STATUS = Object.freeze({
  UNCHANGED: "unchanged",
  ADDED: "added",
  REMOVED: "removed",
  MODIFIED: "modified",
});

// Colour + style per status. `removed` keeps the node in place (so the reader
// sees where it used to sit) but marks it clearly as gone.
export const DIFF_STYLES = Object.freeze({
  added:     { stroke: "#15803d", fill: "#bbf7d0", edge: "#15803d", dash: null,   opacity: 1 },
  removed:   { stroke: "#b91c1c", fill: "#fecaca", edge: "#b91c1c", dash: "5 3",  opacity: 0.85 },
  modified:  { stroke: "#b45309", fill: "#fde68a", edge: "#b45309", dash: null,   opacity: 1 },
  unchanged: { stroke: null,      fill: null,      edge: null,      dash: null,   opacity: 0.45 },
});

// ── Diff computation ────────────────────────────────────────────────────────

const edgeKey = (e) => `${e.from}\u0000${e.to}`;

// Compare two element records for a meaningful (author-visible) change.
// Returns an array of changed field names; empty means "equal".
function elementChanges(a, b) {
  const changed = [];
  if (a.kind !== b.kind) changed.push("kind");
  if ((a.label || a.id) !== (b.label || b.id)) changed.push("label");
  if ((a.lane || null) !== (b.lane || null)) changed.push("lane");
  if (!sameFields(a.fields, b.fields)) changed.push("fields");
  if (!sameStringSet(a.reads, b.reads)) changed.push("reads");
  return changed;
}

function sameFields(fa = [], fb = []) {
  if (fa.length !== fb.length) return false;
  const norm = (f) => `${f.name}:${f.type}:${f.axis ? 1 : 0}`;
  const sa = fa.map(norm).sort();
  const sb = fb.map(norm).sort();
  return sa.every((x, i) => x === sb[i]);
}

function sameStringSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

// Classify a keyed collection across old/new. `keyOf` extracts the identity;
// `changesOf(oldItem, newItem)` returns an array of changed fields (or [] when
// the two are equivalent). Returns a Map keyed by identity, each entry:
//   { status, key, old, new, changes }
function diffCollection(oldItems, newItems, keyOf, changesOf) {
  const oldMap = new Map(oldItems.map((it) => [keyOf(it), it]));
  const newMap = new Map(newItems.map((it) => [keyOf(it), it]));
  const out = new Map();

  for (const [key, oldItem] of oldMap) {
    if (!newMap.has(key)) {
      out.set(key, { status: DIFF_STATUS.REMOVED, key, old: oldItem, new: null, changes: [] });
    } else {
      const newItem = newMap.get(key);
      const changes = changesOf ? changesOf(oldItem, newItem) : [];
      out.set(key, {
        status: changes.length ? DIFF_STATUS.MODIFIED : DIFF_STATUS.UNCHANGED,
        key, old: oldItem, new: newItem, changes,
      });
    }
  }
  for (const [key, newItem] of newMap) {
    if (!oldMap.has(key)) {
      out.set(key, { status: DIFF_STATUS.ADDED, key, old: null, new: newItem, changes: [] });
    }
  }
  return out;
}

// Accept either a DSL/markdown string or an already-parsed model object.
function asModel(srcOrModel) {
  if (srcOrModel && typeof srcOrModel === "object" && Array.isArray(srcOrModel.elements)) {
    return srcOrModel;
  }
  return parseEventModel(String(srcOrModel ?? ""));
}

// Compute the diff between two model versions.
//
//   computeModelDiff(oldSrc, newSrc) => {
//     elements:   Map<id,   entry>,
//     edges:      Map<key,  entry>,
//     actors:     Map<name, entry>,
//     aggregates: Map<name, entry>,
//     slices:     Map<id,   entry>,
//     summary:    { added, removed, modified, unchanged } counts over elements+edges,
//   }
export function computeModelDiff(oldSrcOrModel, newSrcOrModel) {
  const oldModel = asModel(oldSrcOrModel);
  const newModel = asModel(newSrcOrModel);

  const elements = diffCollection(
    oldModel.elements, newModel.elements,
    (el) => el.id,
    elementChanges
  );
  const edges = diffCollection(
    oldModel.edges, newModel.edges,
    edgeKey,
    null // edges are identity-only: present or not
  );
  const actors = diffCollection(
    oldModel.actors.map((n) => ({ name: n })), newModel.actors.map((n) => ({ name: n })),
    (a) => a.name, null
  );
  const aggregates = diffCollection(
    oldModel.aggregates.map((n) => ({ name: n })), newModel.aggregates.map((n) => ({ name: n })),
    (a) => a.name, null
  );
  const slices = diffCollection(
    oldModel.slices, newModel.slices,
    (s) => s.id,
    (a, b) => (sameStringSet(a.edges.map(edgeKey), b.edges.map(edgeKey)) ? [] : ["edges"])
  );

  const summary = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  for (const coll of [elements, edges]) {
    for (const { status } of coll.values()) summary[status]++;
  }

  return { elements, edges, actors, aggregates, slices, oldModel, newModel, summary };
}

// ── Union model (so removed + added both appear in one diagram) ─────────────

// Build a single parsed model that is the union of both versions. The new
// version's element definition wins where an id exists in both (so labels and
// fields reflect the latest); removed elements are carried over from the old
// version so the reader still sees them in place.
export function buildUnionModel(diff) {
  const elements = [];
  for (const entry of diff.elements.values()) {
    elements.push(entry.new || entry.old);
  }
  const edges = [];
  for (const entry of diff.edges.values()) {
    const e = entry.new || entry.old;
    edges.push({ from: e.from, to: e.to });
  }
  // Lanes: union of actor/aggregate names, preserving new-version order first.
  const actors = unionNames(diff.actors);
  const aggregates = unionNames(diff.aggregates);
  // Slices: union by id (new wins).
  const slices = [];
  for (const entry of diff.slices.values()) slices.push(entry.new || entry.old);

  return { actors, aggregates, elements, edges, slices };
}

function unionNames(coll) {
  const names = [];
  const seen = new Set();
  // new-version entries first (added + unchanged/modified keep new order-ish)
  for (const entry of coll.values()) {
    const name = (entry.new || entry.old).name;
    if (!seen.has(name)) { seen.add(name); names.push(name); }
  }
  return names;
}

// ── Rendering ───────────────────────────────────────────────────────────────

// Render the union diagram into `target` and colour it by change status.
// Returns { svg, diff, layout, model } — `model` is the union model rendered.
export function renderModelDiff(oldSrcOrModel, newSrcOrModel, target) {
  const diff = computeModelDiff(oldSrcOrModel, newSrcOrModel);
  const unionModel = buildUnionModel(diff);
  // renderEventModel accepts DSL source; feed it the parsed union model by
  // round-tripping through a tiny shim: it parses strings, but we already have
  // a model. To avoid re-serialising the DSL we call the same internals it
  // uses. renderEventModel only needs a model, so we pass source when we have
  // it; here we serialise the union model back to DSL for a single code path.
  const unionSrc = serializeModel(unionModel);
  const { svg, layout, model } = renderEventModel(unionSrc, target);
  applyDiffOverlay(svg, diff);
  return { svg, diff, layout, model };
}

// Apply change-status styling to an already-rendered diagram (pure DOM, no
// layout changes) — mirrors applySliceFilter's approach so the two compose.
//
//   svgEl — the <svg> element (or a d3 selection of it)
//   diff  — the object returned by computeModelDiff
export function applyDiffOverlay(svgEl, diff) {
  const el = svgEl && svgEl.node ? svgEl.node() : svgEl;
  if (!el) return;

  const statusOfNode = new Map();
  for (const [id, entry] of diff.elements) statusOfNode.set(id, entry);

  // Nodes: recolour the node-bg rect and set group opacity by status.
  el.querySelectorAll("g.node[data-node-id]").forEach((g) => {
    const id = g.getAttribute("data-node-id");
    const entry = statusOfNode.get(id);
    const status = entry ? entry.status : DIFF_STATUS.UNCHANGED;
    const style = DIFF_STYLES[status];
    g.setAttribute("data-diff-status", status);
    g.style.opacity = String(style.opacity);
    if (style.fill || style.stroke) {
      const rect = g.querySelector("rect.node-bg") || g.querySelector("rect");
      if (rect) {
        if (style.fill) rect.style.fill = style.fill;
        if (style.stroke) { rect.style.stroke = style.stroke; rect.style.strokeWidth = "2.5"; }
        if (style.dash) rect.style.strokeDasharray = style.dash;
      }
    }
    // Struck-through label for removed elements.
    if (status === DIFF_STATUS.REMOVED) {
      g.querySelectorAll("text").forEach((t) => { t.style.textDecoration = "line-through"; });
    }
    // Tooltip describing what changed.
    if (entry && (status === DIFF_STATUS.MODIFIED) && entry.changes.length) {
      ensureTitle(g, `modified: ${entry.changes.join(", ")}`);
    } else if (status !== DIFF_STATUS.UNCHANGED) {
      ensureTitle(g, status);
    }
  });

  // Edges: colour by status; a removed edge is dashed red, added is green.
  el.querySelectorAll("path.edge").forEach((p) => {
    const from = p.getAttribute("data-from");
    const to = p.getAttribute("data-to");
    const entry = diff.edges.get(`${from}\u0000${to}`);
    const status = entry ? entry.status : DIFF_STATUS.UNCHANGED;
    const style = DIFF_STYLES[status];
    p.setAttribute("data-diff-status", status);
    p.style.opacity = String(style.opacity);
    if (style.edge) { p.style.stroke = style.edge; p.style.strokeWidth = "2"; }
    if (style.dash) p.style.strokeDasharray = style.dash;
  });
}

function ensureTitle(g, text) {
  let title = g.querySelector(":scope > title");
  if (!title) {
    title = g.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "title");
    g.insertBefore(title, g.firstChild);
  }
  title.textContent = text;
}

// ── Minimal model → DSL serialisation (for the union render path) ───────────
//
// The union model is fed back through the DSL parser via renderEventModel.
// This emits a canonical eventModel block that parseEventModel round-trips.
export function serializeModel(model) {
  const lines = ["eventModel"];
  for (const a of model.actors) lines.push(`  actor ${a}`);
  for (const a of model.aggregates) lines.push(`  aggregate ${a}`);
  lines.push("");

  for (const el of model.elements) {
    const laneQual = el.lane ? `:${el.lane}` : "";
    const label = el.label && el.label !== el.id ? `["${el.label}"]` : "";
    const hasFields = el.fields && el.fields.length;
    let head = `  ${el.kind}${laneQual} ${el.id}${label}`;
    // Inline reads clause (flat union) if present and no structured branches needed.
    if (el.reads && el.reads.length) head += ` reads [${el.reads.join(", ")}]`;
    if (hasFields) {
      lines.push(`${head} {`);
      for (const f of el.fields) lines.push(`    ${f.axis ? "*" : ""}${f.name}: ${f.type}`);
      lines.push("  }");
    } else {
      lines.push(head);
    }
  }
  lines.push("");
  for (const e of model.edges) lines.push(`  ${e.from}-->${e.to}`);
  lines.push("");
  for (const s of model.slices) {
    const label = s.label && s.label !== s.id ? `["${s.label}"]` : "";
    lines.push(`  slice ${s.id}${label}`);
    for (const e of s.edges) lines.push(`    ${e.from}-->${e.to}`);
  }
  return lines.join("\n");
}
