import * as d3 from "d3";

// URL of the gear icon used to render automation nodes. Resolved relative
// to this module's URL so it works in-repo, in the published npm package,
// and via CDN (settings.png must be listed in package.json:files).
const AUTOMATION_IMG_URL = new URL("./settings.png", import.meta.url).href;

// Automation nodes use a label strip on top and the gear image below.
const AUTOMATION_LABEL_H = 22;
const AUTOMATION_IMG_H = 58;
const AUTOMATION_NODE_H = AUTOMATION_LABEL_H + AUTOMATION_IMG_H;

// Event Model DSL → SVG renderer.
//
// Grammar (see blueprint_dsl):
//   actor <Name>
//   aggregate <Name>
//   ui:<Actor>         <id>[["Label"]]?
//   command            <id>[["Label"]]?
//   domainEvent:<Agg>  <id>[["Label"]]?
//   readModel          <id>[["Label"]]?
//   automation:<Actor> <id>[["Label"]]?
//   <id> --> <id>
//
// Layout model: columns come from a topological rank of the causal flow
// (back-edges broken by DFS so cycles like paymentSucceeded↔paymentsToProcess
// don't run away; declaration order provides a monotonic floor so flows with
// no incoming edge still fall in the right time slot). Swimlanes stack
// top→bottom: actors → Time → aggregates. Every element is pinned to
// (column, lane) so elements in the same causal step line up vertically
// across all lanes — the defining property of an Event Model.

// If `src` is a markdown document containing the DSL inside a fenced code
// block, return just the block's body. Otherwise return src unchanged. This
// lets every caller (the renderer, the Mermaid adapter, downstream tooling)
// accept either a raw DSL string or a `.md` file's text without branching.
function extractFromMarkdown(src, keyword) {
  const firstNonEmpty = src.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (firstNonEmpty && new RegExp(`^${keyword}\\b`).test(firstNonEmpty.trim())) {
    return src;
  }
  const re = /```(?:[\w-]+)?[\t ]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (new RegExp(`^\\s*${keyword}\\b`).test(m[1])) return m[1];
  }
  return src;
}

function parseEventModel(src) {
  src = extractFromMarkdown(src, "eventModel");
  // The `:<lane>` qualifier on domainEvent is optional in DCB models (no aggregates).
  // The optional `reads [a, b, c]` clause on commands lists past event types the
  // command must consult for consistency — a directive to the event-sourcing
  // framework, not a flow edge.
  // `externalEvent` is a fact originating outside the system (e.g. a webhook
  // from a third-party service); it sits in a synthesized `External` lane
  // above the actor lanes.
  const elementRe =
    /^(ui|command|domainEvent|externalEvent|readModel|automation)(?::(\w+))?\s+(\w+)(?:\s*\["([^"]*)"\])?(?:\s+reads\s*\[([^\]]*)\])?\s*(\{)?\s*$/;
  const edgeRe = /^(\w+)\s*-->\s*(\w+)$/;
  const actorRe = /^actor\s+(\w+)$/;
  const aggRe = /^aggregate\s+(\w+)$/;
  // A leading `*` marks the field as a tag axis: an independent handle a
  // decision may scope its consistency boundary to. An event carries zero to N
  // of them and they never compose into a key — composition happens command-side.
  const fieldRe = /^(\*)?\s*(\w+)\s*:\s*(\w+)$/;
  // `reads [a, b] by axis` — one branch of a boundary. Branches are OR'd; the
  // bracketed `by [x, y]` form AND's axes within a single branch.
  const readsClauseRe =
    /^reads\s*\[([^\]]*)\]\s*(?:by\s*(?:\[([^\]]*)\]|(\w+)))?\s*$/;
  const sliceRe = /^slice\s+(\w+)(?:\s*\["([^"]*)"\])?\s*$/;

  const actors = [];
  const aggregates = [];
  const elements = [];
  const edges = [];
  const slices = [];

  const lines = src.split(/\r?\n/);
  const indentOf = (raw) => raw.match(/^[\t ]*/)[0].length;
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    const lineIndent = indentOf(raw);
    i++;
    if (!line || line === "eventModel") continue;

    let m;
    if ((m = line.match(actorRe))) { actors.push(m[1]); continue; }
    if ((m = line.match(aggRe)))   { aggregates.push(m[1]); continue; }
    if ((m = line.match(sliceRe))) {
      // A slice declaration is followed by an indented block of edges. Only
      // consume lines whose indent is strictly greater than the slice line's
      // indent; dedenting back to <= that level ends the slice.
      const [, id, label] = m;
      const sliceEdges = [];
      const nodeSet = new Set();
      while (i < lines.length) {
        const nextRaw = lines[i];
        const nextLine = nextRaw.trim();
        if (!nextLine) { i++; continue; }
        if (indentOf(nextRaw) <= lineIndent) break;
        const em = nextLine.match(edgeRe);
        if (!em) { i++; continue; }
        edges.push({ from: em[1], to: em[2] });
        sliceEdges.push({ from: em[1], to: em[2] });
        nodeSet.add(em[1]); nodeSet.add(em[2]);
        i++;
      }
      slices.push({ id, label: label || id, edges: sliceEdges, nodeIds: [...nodeSet] });
      continue;
    }
    if ((m = line.match(elementRe))) {
      const [, kind, lane, id, label, readsList, openBrace] = m;
      const fields = [];
      if (openBrace) {
        // Consume lines until closing brace.
        while (i < lines.length) {
          const fl = lines[i].trim();
          i++;
          if (fl === "}") break;
          const fm = fl.match(fieldRe);
          if (fm) fields.push({ name: fm[2], type: fm[3], axis: !!fm[1] });
        }
      }
      // A boundary is an OR of branches. The inline `reads [...]` form is a
      // single branch whose axis is derived; each following indented
      // `reads [...] by <axis>` line adds a further branch explicitly.
      const readBranches = [];
      if (readsList) {
        readBranches.push({
          events: readsList.split(",").map((s) => s.trim()).filter(Boolean),
          axes: [],
        });
      }
      while (i < lines.length) {
        const nextRaw = lines[i];
        const nextLine = nextRaw.trim();
        if (!nextLine) { i++; continue; }
        if (indentOf(nextRaw) <= lineIndent) break;
        const rm = nextLine.match(readsClauseRe);
        if (!rm) break;
        readBranches.push({
          events: rm[1].split(",").map((s) => s.trim()).filter(Boolean),
          axes: (rm[2] ?? rm[3] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        });
        i++;
      }
      // `reads` remains the flat union of every branch's event ids: it is what
      // the renderer draws as tags, and what add-slices ignores for layout.
      const reads = [...new Set(readBranches.flatMap((b) => b.events))];
      elements.push({ id, kind, lane: lane || null, label: label || id, fields, reads, readBranches });
      continue;
    }
    if ((m = line.match(edgeRe))) {
      edges.push({ from: m[1], to: m[2] });
      continue;
    }
    // Unknown lines are ignored so the DSL can evolve without breaking render.
  }

  return { actors, aggregates, elements, edges, slices };
}

// A data-section field's display text. A leading `*` marks a tag axis — an
// independent handle a decision may scope its consistency boundary to. Shown
// because choosing the wrong one is the most expensive mistake in a DCB model
// and it should be visible on the diagram, not buried in the source.
function fieldText(f) {
  return `${f.axis ? "*" : ""}${f.name}: ${f.type}`;
}

function computeRanks(elements, edges) {
  // 1) DFS to find back-edges (edges to a GRAY/in-stack ancestor).
  const ids = new Set(elements.map((e) => e.id));
  const adj = new Map(elements.map((e) => [e.id, []]));
  for (const e of edges) {
    if (e.from === e.to) continue;
    if (ids.has(e.from) && ids.has(e.to)) adj.get(e.from).push(e.to);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const state = new Map(elements.map((e) => [e.id, WHITE]));
  const back = new Set();
  const SEP = "\u0001";
  const stack = [];
  function dfs(root) {
    // Iterative DFS to avoid blowing the stack on deep chains.
    stack.push({ u: root, i: 0 });
    state.set(root, GRAY);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const children = adj.get(top.u);
      if (top.i < children.length) {
        const v = children[top.i++];
        const s = state.get(v);
        if (s === WHITE) {
          state.set(v, GRAY);
          stack.push({ u: v, i: 0 });
        } else if (s === GRAY) {
          back.add(top.u + SEP + v);
        }
      } else {
        state.set(top.u, BLACK);
        stack.pop();
      }
    }
  }
  for (const el of elements) if (state.get(el.id) === WHITE) dfs(el.id);

  const forward = edges.filter(
    (e) => e.from !== e.to && ids.has(e.from) && ids.has(e.to) && !back.has(e.from + SEP + e.to)
  );

  // 2) Kahn's topological sort with declaration-order tiebreaking. Each
  //    element gets its own unique column — no two elements share a column,
  //    even across lanes. Causality is preserved (forward edges always go
  //    left→right); when multiple elements are simultaneously ready, the
  //    earliest-declared wins.
  const declIdx = new Map(elements.map((e, i) => [e.id, i]));
  const indeg = new Map(elements.map((e) => [e.id, 0]));
  const succ = new Map(elements.map((e) => [e.id, []]));
  for (const e of forward) {
    indeg.set(e.to, indeg.get(e.to) + 1);
    succ.get(e.from).push(e.to);
  }

  const insertSorted = (arr, id) => {
    const di = declIdx.get(id);
    let i = 0;
    while (i < arr.length && declIdx.get(arr[i]) < di) i++;
    arr.splice(i, 0, id);
  };

  const ready = [];
  for (const el of elements) if (indeg.get(el.id) === 0) insertSorted(ready, el.id);

  const rank = new Map();
  let col = 0;
  while (ready.length) {
    const id = ready.shift();
    rank.set(id, col++);
    for (const v of succ.get(id)) {
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) insertSorted(ready, v);
    }
  }
  // Any strays (shouldn't happen now that back-edges are removed) get
  // trailing columns so nothing is dropped.
  for (const el of elements) if (!rank.has(el.id)) rank.set(el.id, col++);

  return rank;
}

// When a read model is updated by multiple domain (or external) events, render
// a visual stub of the read model next to each producing event so the diagram
// avoids long fan-in arcs. The original read model is anchored to the leftmost
// source event; each subsequent source gets a duplicate stub above it. When
// the read model's outgoing edges all flow further right than the last source
// (the classic fan-in shape), those outgoing edges are rerouted to come from
// the rightmost duplicate so the downstream connection stays short. When a
// read model participates in a cycle (e.g. `paymentSucceeded → paymentsToProcess
// → paymentProcessor`), the outgoing edges stay on the original to preserve
// the forward-flowing layout.
function expandReadModelDuplicates(elements, edges, rank) {
  const incoming = new Map();
  for (const e of edges) {
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to).push(e.from);
  }
  const elById = new Map(elements.map((el) => [el.id, el]));
  const newElements = [...elements];
  const newEdges = [...edges];
  const dupeMap = new Map();

  for (const el of elements) {
    if (el.kind !== "readModel") continue;
    const sources = incoming.get(el.id) || [];
    const eventSources = sources.filter((srcId) => {
      const src = elById.get(srcId);
      return src && (src.kind === "domainEvent" || src.kind === "externalEvent");
    });
    if (eventSources.length < 2) continue;

    // Sort by natural column so "first" means leftmost and "last" means rightmost.
    eventSources.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    const firstSourceId = eventSources[0];
    const lastSourceId = eventSources[eventSources.length - 1];
    const lastSourceRank = rank.get(lastSourceId) ?? 0;

    // First source keeps its edge to the original; the rest get duplicates.
    const duplicates = [];
    for (let i = 1; i < eventSources.length; i++) {
      const sourceId = eventSources[i];
      const dupId = `${el.id}__dup_${i}`;
      newElements.push({
        id: dupId,
        kind: "readModel",
        lane: null,
        label: el.label,
        fields: el.fields,
        reads: [],
        isDuplicate: true,
        originalId: el.id,
      });
      const idx = newEdges.findIndex(
        (e) => e.from === sourceId && e.to === el.id
      );
      if (idx >= 0) newEdges[idx] = { from: sourceId, to: dupId };
      duplicates.push({ id: dupId, sourceId });
    }
    const lastDupId = duplicates[duplicates.length - 1].id;

    // Reroute outgoing edges from the original to the last duplicate when
    // every outgoing target sits past the last source — the fan-in pattern.
    // Otherwise keep them on the original (cycle/back-flowing case).
    const outgoing = newEdges.filter((e) => e.from === el.id);
    const allDownstream =
      outgoing.length > 0 &&
      outgoing.every((e) => {
        const tRank = rank.get(e.to);
        return tRank !== undefined && tRank > lastSourceRank;
      });
    if (allDownstream) {
      for (let j = 0; j < newEdges.length; j++) {
        if (newEdges[j].from === el.id) {
          newEdges[j] = { from: lastDupId, to: newEdges[j].to };
        }
      }
    }

    dupeMap.set(el.id, { originalId: el.id, firstSourceId, duplicates });
  }
  return { elements: newElements, edges: newEdges, dupeMap };
}

// A duplicate only earns its keep when it stands in for a long fan-in arc.
// When two copies of the same read model land in adjacent columns they read as
// two distinct projections sitting side by side — worse than the arc they were
// avoiding. Collapse each run of adjacent copies into its leftmost box and let
// the other source events in the run draw their own short arrows into it.
function mergeAdjacentReadModelDuplicates(elements, edges, rank, dupeMap) {
  if (!dupeMap || dupeMap.size === 0) return { elements, edges };

  // The column each element will occupy once ranks are packed: its position
  // among the distinct ranks still in use. Adjacent columns differ by one.
  const distinct = [...new Set(elements.map((el) => rank.get(el.id)))].sort(
    (a, b) => a - b
  );
  const colOf = new Map(distinct.map((r, i) => [r, i]));
  const columnOf = (id) => colOf.get(rank.get(id));

  const mergedInto = new Map();
  for (const info of dupeMap.values()) {
    // Left to right: the original sits on the leftmost source event, then each
    // duplicate on its own source, in source order.
    const rendered = [info.originalId, ...info.duplicates.map((d) => d.id)];

    // Split into runs of copies occupying consecutive columns. Compare each
    // copy against the previous one even once that one has been merged away,
    // so three adjacent copies collapse into one box rather than two.
    const runs = [[rendered[0]]];
    for (let i = 1; i < rendered.length; i++) {
      if (columnOf(rendered[i]) - columnOf(rendered[i - 1]) === 1) {
        runs[runs.length - 1].push(rendered[i]);
      } else {
        runs.push([rendered[i]]);
      }
    }

    for (const run of runs) {
      if (run.length === 1) continue;
      const survivor = run[0];
      for (const id of run.slice(1)) mergedInto.set(id, survivor);
      // Sit the surviving box over the middle of the run so its incoming
      // arrows stay short and fan out symmetrically instead of all reaching
      // back to the leftmost column.
      rank.set(survivor, rank.get(run[Math.floor((run.length - 1) / 2)]));
    }
    info.duplicates = info.duplicates.filter((d) => !mergedInto.has(d.id));
  }
  if (mergedInto.size === 0) return { elements, edges };

  const resolve = (id) => (mergedInto.has(id) ? mergedInto.get(id) : id);
  const seen = new Set();
  const mergedEdges = [];
  for (const e of edges) {
    const from = resolve(e.from);
    const to = resolve(e.to);
    if (from === to) continue;
    const key = from + "\u0001" + to;
    if (seen.has(key)) continue;
    seen.add(key);
    mergedEdges.push({ ...e, from, to });
  }
  return {
    elements: elements.filter((el) => !mergedInto.has(el.id)),
    edges: mergedEdges,
  };
}

// Renumber column ranks to consecutive integers, removing any gaps left by
// manual overrides (e.g. when a read model is shifted leftward into its first
// source's column, the column it previously occupied becomes empty).
function packColumns(rank) {
  const sorted = [...new Set(rank.values())].sort((a, b) => a - b);
  const map = new Map(sorted.map((v, i) => [v, i]));
  for (const [k, v] of rank) rank.set(k, map.get(v));
}

// Slices are declared against the original DSL edges. After read-model
// duplication, those declared edges may have been rerouted (incoming to a
// duplicate, outgoing from the rightmost duplicate). Rewrite each slice's
// nodeIds to reference the actually-rendered endpoints, so bounding boxes
// snap to what's drawn instead of stretching back to the original.
function rewriteSliceNodeIdsForDuplicates(slices, edges, dupeMap) {
  if (!slices || slices.length === 0) return;
  if (!dupeMap || dupeMap.size === 0) return;

  const originalByDup = new Map();
  for (const info of dupeMap.values()) {
    for (const d of info.duplicates) originalByDup.set(d.id, info.originalId);
  }
  const sameOrAlias = (actualId, declaredId) =>
    actualId === declaredId || originalByDup.get(actualId) === declaredId;

  for (const slice of slices) {
    const nodes = new Set();
    for (const sliceEdge of slice.edges) {
      const match = edges.find(
        (e) => sameOrAlias(e.from, sliceEdge.from) && sameOrAlias(e.to, sliceEdge.to)
      );
      if (match) {
        nodes.add(match.from);
        nodes.add(match.to);
      } else {
        nodes.add(sliceEdge.from);
        nodes.add(sliceEdge.to);
      }
    }
    slice.nodeIds = [...nodes];
  }
}

function layoutEventModel(model) {
  const { actors, aggregates } = model;

  // 1. Rank the original (untouched) graph so we know each element's natural
  //    column before any read-model rewriting.
  const rank = computeRanks(model.elements, model.edges);

  // 2. Expand fan-in read models into duplicate visual stubs. The expander
  //    uses `rank` to decide whether to reroute the original's outgoing
  //    edges to the rightmost duplicate.
  let { elements, edges, dupeMap } = expandReadModelDuplicates(
    model.elements,
    model.edges,
    rank
  );

  // 3. Override column assignments: anchor each fan-in original to its first
  //    source event's column (leftmost), and assign each duplicate the
  //    column of its source event so it sits directly above it.
  for (const info of dupeMap.values()) {
    rank.set(info.originalId, rank.get(info.firstSourceId));
    for (const dup of info.duplicates) {
      rank.set(dup.id, rank.get(dup.sourceId));
    }
  }

  // 3b. Collapse copies that ended up side by side. Duplication buys short
  //     arrows; when the sources are already neighbours there is no arc to
  //     shorten, so one box with two incoming arrows is the truer picture.
  ({ elements, edges } = mergeAdjacentReadModelDuplicates(
    elements,
    edges,
    rank,
    dupeMap
  ));

  // 4. Pack columns to close gaps left by the overrides.
  packColumns(rank);

  // 5. Rewrite each slice's nodeIds to reference the actually-rendered
  //    endpoints (duplicates instead of originals where edges were rerouted).
  rewriteSliceNodeIdsForDuplicates(model.slices, edges, dupeMap);

  // DCB models declare events without an aggregate qualifier. When any such
  // event exists, synthesize a single "Events" lane below the time lane to
  // hold them. Aggregate-qualified events still go to their named lane.
  const hasUnqualifiedEvents = elements.some(
    (el) => el.kind === "domainEvent" && !el.lane
  );

  // External events (facts originating outside the system) live in a
  // synthesized lane at the very top of the stack, above all actors.
  const hasExternalEvents = elements.some(
    (el) => el.kind === "externalEvent"
  );

  const lanes = [
    ...(hasExternalEvents
      ? [{ key: "external", title: "External", kind: "external" }]
      : []),
    ...actors.map((a) => ({ key: "actor:" + a, title: a, kind: "actor" })),
    { key: "time", title: "Time", kind: "time" },
    ...aggregates.map((a) => ({ key: "agg:" + a, title: a, kind: "aggregate" })),
    ...(hasUnqualifiedEvents
      ? [{ key: "events", title: "Events", kind: "events" }]
      : []),
  ];
  const laneIndex = new Map(lanes.map((l, i) => [l.key, i]));

  const laneKeyOf = (el) => {
    if (el.kind === "ui" || el.kind === "automation") return "actor:" + el.lane;
    if (el.kind === "domainEvent") return el.lane ? "agg:" + el.lane : "events";
    if (el.kind === "externalEvent") return "external";
    return "time";
  };

  // Bucket into (lane, col); multiple elements in the same cell stack vertically.
  // Two read models fed by the same event are both anchored to that event's
  // column by the duplicate expander, which lands them in one lane/column cell
  // and stacks them vertically. They are distinct projections, so give each
  // extra its own column instead — shifting everything to the right along with
  // it. Stacking would read as containment.
  {
    const occupied = new Set();
    const ordered = elements
      .slice()
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    for (const el of ordered) {
      let col = rank.get(el.id);
      const laneKey = laneKeyOf(el);
      if (!occupied.has(laneKey + "|" + col)) {
        occupied.add(laneKey + "|" + col);
        continue;
      }
      // Open a fresh column immediately after this one and move the element
      // into it, pushing every later column right to make room.
      for (const [id, c] of rank) if (c > col) rank.set(id, c + 1);
      rank.set(el.id, col + 1);
      occupied.add(laneKey + "|" + (col + 1));
    }
  }

  const cells = new Map();
  for (const el of elements) {
    const laneKey = laneKeyOf(el);
    const col = rank.get(el.id);
    const k = laneKey + "|" + col;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(el);
  }

  // Dimensions.
  const MARGIN_L = 120;
  const MARGIN_T = 24;
  const MARGIN_R = 40;
  const MARGIN_B = 24;
  const NODE_H_BASE = 54;
  const FIELD_LINE_H = 16;
  const LANE_PAD = 14;
  const SUB_GAP = 8;
  const COL_GAP = 10;
  const NODE_W_MIN = 140;

  // Approximate character widths for the two font sizes used.
  const LABEL_CHAR_W = 7;   // font-size 12
  const FIELD_CHAR_W = 6;   // font-size 10
  const LABEL_PAD = 24;     // horizontal padding for centered heading text
  const FIELD_PAD = 20;     // left 8 + right 12 padding for field text

  // Compute the minimum width each element needs to fit its content.
  const nodeW = (el) => {
    // Width needed for the widest wrapped label line.
    const lines = wrapLabel(el.label, 20);
    const maxLabelW = Math.max(...lines.map((l) => l.length)) * LABEL_CHAR_W + LABEL_PAD;

    // Width needed for the widest field line.
    let maxFieldW = 0;
    if (el.fields && el.fields.length > 0) {
      for (const f of el.fields) {
        const fw = fieldText(f).length * FIELD_CHAR_W + FIELD_PAD;
        if (fw > maxFieldW) maxFieldW = fw;
      }
    }

    // `reads` tags do NOT widen the command box — they overflow to the
    // right of the box and into the column gutter. Width is determined by
    // labels and fields only.
    return Math.max(NODE_W_MIN, maxLabelW, maxFieldW);
  };

  // Use a uniform node width sized to the widest element.
  let NODE_W = NODE_W_MIN;
  for (const el of elements) {
    const w = nodeW(el);
    if (w > NODE_W) NODE_W = w;
  }
  // Round up to even number for clean centering.
  NODE_W = Math.ceil(NODE_W / 2) * 2;

  const COL_W = NODE_W + COL_GAP;

  // Per-element height: base heading + optional fields section. `reads`
  // entries no longer add height — they render as small tags overlaid on
  // the heading section in the upper-right.
  const nodeH = (el) => {
    if (el.kind === "automation") return AUTOMATION_NODE_H;
    const hasFields = el.fields && el.fields.length > 0;
    if (!hasFields) return NODE_H_BASE;
    return NODE_H_BASE + el.fields.length * FIELD_LINE_H + 4;
  };

  // Track the tallest stack per lane for lane sizing.
  const maxStackH = new Map(lanes.map((l) => [l.key, NODE_H_BASE]));
  for (const [k, arr] of cells) {
    const laneKey = k.split("|")[0];
    let stackH = 0;
    for (const el of arr) stackH += nodeH(el);
    stackH += Math.max(0, arr.length - 1) * SUB_GAP;
    if (stackH > maxStackH.get(laneKey)) maxStackH.set(laneKey, stackH);
  }

  const laneRects = [];
  let y = MARGIN_T;
  for (const lane of lanes) {
    const h = LANE_PAD * 2 + maxStackH.get(lane.key);
    laneRects.push({ ...lane, y, h });
    y += h;
  }
  let totalH = y + MARGIN_B;

  let maxCol = 0;
  for (const v of rank.values()) if (v > maxCol) maxCol = v;

  // Tag-overflow accounting: a command's `reads` tags overflow to the right
  // of the box, into the column gutter and possibly into the following
  // column. Where they would land on top of the next-column element, push
  // that column further right by the overflow amount + a small buffer.
  // Tag-rendering constants must mirror the values used in `drawInto`.
  const TAG_NOTCH_L      = 9;
  const TAG_HOLE_GAP_L   = 6;
  const TAG_HOLE_R_L     = 2.2;
  const TAG_LEFT_TX_L    = 5;
  const TAG_RIGHT_TX_L   = 6;
  const TAG_LEFT_GAP_L   = 8;
  const TAG_CHAR_W_L     = 6.5;
  const TAG_OVERFLOW_PAD = 6;

  const labelById = new Map(elements.map((e) => [e.id, e.label]));
  const cmdTagOverflow = new Map(); // id → overflow past command's right edge

  for (const el of elements) {
    if (el.kind !== "command" || !el.reads || el.reads.length === 0) continue;
    let uniformTagW = 0;
    for (const r of el.reads) {
      const txt = labelById.get(r) || r;
      const w =
        TAG_NOTCH_L + TAG_HOLE_GAP_L + TAG_HOLE_R_L + TAG_LEFT_TX_L +
        txt.length * TAG_CHAR_W_L + TAG_RIGHT_TX_L;
      if (w > uniformTagW) uniformTagW = w;
    }
    const lines = wrapLabel(el.label, 20);
    const labelMaxLen = lines.length
      ? Math.max(...lines.map((l) => l.length))
      : 0;
    const titleHalfW = (labelMaxLen * LABEL_CHAR_W) / 2;
    const tagRightRel = NODE_W / 2 + titleHalfW + TAG_LEFT_GAP_L + uniformTagW;
    const overflow = Math.max(0, tagRightRel - NODE_W);
    if (overflow > 0) cmdTagOverflow.set(el.id, overflow);
  }

  // Per-column extra spacing inserted BEFORE that column's left edge.
  const colExtraSpace = new Map();
  for (const [id, overflow] of cmdTagOverflow) {
    const intoNextCol = overflow - COL_GAP;
    if (intoNextCol <= 0) continue;
    const targetCol = rank.get(id) + 1;
    const need = intoNextCol + TAG_OVERFLOW_PAD;
    if (need > (colExtraSpace.get(targetCol) || 0)) {
      colExtraSpace.set(targetCol, need);
    }
  }

  // Build per-column x positions with the extra space baked in.
  const colXMap = new Map();
  let xCursor = MARGIN_L;
  for (let c = 0; c <= maxCol; c++) {
    xCursor += colExtraSpace.get(c) || 0;
    colXMap.set(c, xCursor);
    xCursor += COL_W;
  }

  // If a command at the rightmost column has a tag overflow, there's no
  // column to push — extend the canvas instead.
  let rightExtra = 0;
  for (const [id, overflow] of cmdTagOverflow) {
    if (rank.get(id) !== maxCol) continue;
    if (overflow > rightExtra) rightExtra = overflow;
  }
  const totalW = xCursor + rightExtra + MARGIN_R;

  const pos = new Map();
  for (const [k, arr] of cells) {
    const [laneKey, colStr] = k.split("|");
    const col = +colStr;
    const lr = laneRects[laneIndex.get(laneKey)];
    const nSub = arr.length;
    let totalSubH = 0;
    for (const el of arr) totalSubH += nodeH(el);
    totalSubH += Math.max(0, nSub - 1) * SUB_GAP;
    let curY = lr.y + (lr.h - totalSubH) / 2;
    const cx = colXMap.get(col) + COL_W / 2;
    const nx = cx - NODE_W / 2;
    for (const el of arr) {
      const h = nodeH(el);
      pos.set(el.id, { el, x: nx, y: curY, w: NODE_W, h });
      curY += h + SUB_GAP;
    }
  }

  // Exactly one bounding box per slice. An earlier version split a slice whose
  // members fell into distant column clusters, but two boxes read as two
  // slices. A wide box is the honest picture: it means the slice's members
  // really are far apart, which happens when a read model's own output feeds
  // back into it (see the cycle note in `expandReadModelDuplicates`).
  const SLICE_PAD = 10;
  const SLICE_LABEL_H = 20;
  const sliceRects = [];
  for (const s of model.slices || []) {
    const members = s.nodeIds
      .map((id) => ({ pos: pos.get(id), col: rank.get(id) }))
      .filter((m) => m.pos && m.col !== undefined)
      .sort((a, b) => a.col - b.col);
    if (members.length === 0) continue;

    [members].forEach((cluster) => {
      // One rectangle bounding every member of the cluster. Slices are shown
      // one at a time, so a plain box no longer collides with its neighbours,
      // and it reads far better than an outline snaking between the elements.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const m of cluster) {
        const q = m.pos;
        if (q.x < minX) minX = q.x;
        if (q.y < minY) minY = q.y;
        if (q.x + q.w > maxX) maxX = q.x + q.w;
        if (q.y + q.h > maxY) maxY = q.y + q.h;
      }
      const box = {
        x: minX - SLICE_PAD,
        y: minY - SLICE_PAD,
        w: (maxX - minX) + SLICE_PAD * 2,
        h: (maxY - minY) + SLICE_PAD * 2,
      };

      sliceRects.push({
        id: s.id,
        sliceId: s.id,
        label: s.label,
        box,
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        labelX: box.x + box.w / 2,
        labelY: box.y - SLICE_LABEL_H,
        labelW: Math.max(60, (s.label || "").length * 6.5 + 16),
        labelH: SLICE_LABEL_H,
      });
    });
  }

  // When two slices have horizontally-overlapping label regions at the same
  // vertical level, the labels collide. Walk slices left-to-right and shift
  // any conflicting slice's box upward (its top edge moves up; the bottom
  // stays anchored to its members) until its label clears all earlier ones.
  const labelGap = 4;
  const labelBox = (r) => ({
    x: r.labelX - r.labelW / 2,
    w: r.labelW,
    y: r.labelY,
    h: r.labelH,
  });
  const sortedSlices = sliceRects
    .slice()
    .sort((a, b) => a.labelX - b.labelX || a.labelY - b.labelY);
  for (let i = 0; i < sortedSlices.length; i++) {
    const a = sortedSlices[i];
    if (!a.label) continue;
    let safety = 100;
    while (safety-- > 0) {
      const ab = labelBox(a);
      let conflict = null;
      for (let j = 0; j < i; j++) {
        const b = sortedSlices[j];
        if (!b.label) continue;
        const bb = labelBox(b);
        const xOverlap = !(bb.x + bb.w <= ab.x || ab.x + ab.w <= bb.x);
        if (!xOverlap) continue;
        const yOverlap = !(bb.y + bb.h <= ab.y || ab.y + ab.h <= bb.y);
        if (yOverlap) { conflict = bb; break; }
      }
      if (!conflict) break;
      a.labelY -= conflict.y + conflict.h + labelGap - ab.y;
    }
  }

  // If the upward shifts pushed any slice's top above y=0, shift the entire
  // diagram down so labels stay inside the viewBox.
  let extraTop = 0;
  for (const sr of sliceRects) {
    if (sr.labelY < -extraTop) extraTop = -sr.labelY;
  }
  if (extraTop > 0) {
    extraTop += labelGap;
    for (const lr of laneRects) lr.y += extraTop;
    for (const p of pos.values()) p.y += extraTop;
    for (const sr of sliceRects) {
      sr.y += extraTop;
      sr.labelY += extraTop;
      sr.box.y += extraTop;
    }
    totalH += extraTop;
  }

  const sliceMembers = new Map(
    (model.slices || []).map((s) => [s.id, s.nodeIds.slice()])
  );
  return { lanes: laneRects, pos, edges, elements, slices: sliceRects, sliceMembers, totalW, totalH, MARGIN_L, NODE_H_BASE };
}

const NODE_STYLES = {
  ui:            { fill: "#ffffff", stroke: "#475569", dash: null },
  command:       { fill: "#60a5fa", stroke: "#1e3a8a", dash: null },
  domainEvent:   { fill: "#fb923c", stroke: "#7c2d12", dash: null },
  externalEvent: { fill: "#fbf3a8", stroke: "#854d0e", dash: null },
  readModel:     { fill: "#86efac", stroke: "#14532d", dash: null },
  automation:    { fill: "transparent", stroke: "none", dash: null },
};

export function renderEventModel(src, target) {
  const model = parseEventModel(src);
  const layout = layoutEventModel(model);

  const root = d3.select(target);
  root.selectAll("svg").remove();

  const svg = root
    .append("svg")
    .attr("xmlns", "http://www.w3.org/2000/svg")
    .attr("width", layout.totalW)
    .attr("height", layout.totalH)
    .attr("viewBox", `0 0 ${layout.totalW} ${layout.totalH}`)
    .attr("font-family", "system-ui, -apple-system, sans-serif")
    .attr("font-size", 12);

  drawInto(svg, model, layout);
  return { svg: svg.node(), model, layout };
}

// Draws the event-model diagram into an existing d3 SVG selection. Used by
// both `renderEventModel` (standalone demo) and the Mermaid adapter, which
// receives the SVG element Mermaid has already created.
export function drawInto(svg, model, L) {
  // Wipe any prior content so re-renders don't stack.
  svg.selectAll("*").remove();

  // Arrow marker.
  svg
    .append("defs")
    .append("marker")
      .attr("id", "em-arrow")
      .attr("viewBox", "0 0 10 10")
      .attr("refX", 9)
      .attr("refY", 5)
      .attr("markerWidth", 7)
      .attr("markerHeight", 7)
      .attr("orient", "auto-start-reverse")
    .append("path")
      .attr("d", "M0,0 L10,5 L0,10 z")
      .attr("fill", "#555");

  // Draw-order layers: lanes (background) → axis → edges → nodes (top).
  const gLanes  = svg.append("g").attr("class", "lanes");
  const gAxis   = svg.append("g").attr("class", "axis");
  const gSlices = svg.append("g").attr("class", "slices");
  const gEdges  = svg.append("g").attr("class", "edges");
  const gNodes  = svg.append("g").attr("class", "nodes");

  // --- Lane bands ---------------------------------------------------------
  const laneG = gLanes
    .selectAll("g.lane")
    .data(L.lanes, (d) => d.key)
    .join("g")
    .attr("class", "lane");

  laneG
    .append("rect")
    .attr("x", 0)
    .attr("y", (d) => d.y)
    .attr("width", L.totalW)
    .attr("height", (d) => d.h)
    .attr("fill", (d) => (d.kind === "time" ? "#f3f4f6" : "#ffffff"))
    .attr("stroke", "#e5e7eb");

  laneG
    .append("text")
    .attr("x", 12)
    .attr("y", (d) => d.y + d.h / 2)
    .attr("dominant-baseline", "middle")
    .attr("fill", "#374151")
    .attr("font-weight", 600)
    .text((d) => d.title);

  // --- Time axis ----------------------------------------------------------
  const timeLane = L.lanes.find((l) => l.kind === "time");
  if (timeLane) {
    gAxis
      .append("line")
      .attr("x1", L.MARGIN_L)
      .attr("y1", timeLane.y)
      .attr("x2", L.totalW - 20)
      .attr("y2", timeLane.y)
      .attr("stroke", "#9ca3af")
      .attr("stroke-dasharray", "3 3")
      .attr("marker-end", "url(#em-arrow)");

    gAxis
      .append("text")
      .attr("x", L.totalW - 24)
      .attr("y", timeLane.y - 4)
      .attr("text-anchor", "end")
      .attr("fill", "#6b7280")
      .text("time →");
  }

  // --- Slices -------------------------------------------------------------
  // Dashed bounding box around each vertical slice's member nodes, with the
  // slice label centered at the top inside the box.
  // Each slice draws one band per lane it occupies, joined by vertical stems.
  // Bands are hidden until the slice is selected — 24 always-on boxes over 48
  // nodes read as noise, and every producer/consumer seam makes two of them
  // overlap by exactly one column. The always-visible part is the label chip;
  // hovering it (or any member node) reveals that slice alone.
  // The slug matches the per-slice spec filename that `spec-slices` writes, so
  // a host page can route a chip click to that file. Routing itself belongs to
  // the host, not here — the renderer only publishes the slug.
  const sliceSlug = (label) =>
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") + ".md";

  const sliceG = gSlices
    .selectAll("g.slice")
    .data(L.slices || [], (d) => d.id)
    .join("g")
    .attr("class", "slice")
    // The base slice id (shared across split clusters) so a host page can
    // discover every slice in the diagram and drive interactive filtering.
    .attr("data-slice-id", (d) => d.sliceId)
    .attr("data-slice-label", (d) => d.label || d.sliceId)
    // The slug matches the per-slice spec filename so a host page can route a
    // chip click to that file (see wireSliceLinks in the viewer).
    .attr("data-slice-slug", (d) => (d.label ? sliceSlug(d.label) : null));

  const bandsG = sliceG
    .append("g")
    .attr("class", "slice-bands")
    .attr("opacity", 0)
    .attr("pointer-events", "none");

  bandsG
    .append("rect")
    .attr("x", (d) => d.box.x)
    .attr("y", (d) => d.box.y)
    .attr("width", (d) => d.box.w)
    .attr("height", (d) => d.box.h)
    .attr("rx", 6)
    .attr("ry", 6)
    .attr("fill", "#64748b")
    .attr("fill-opacity", 0.06)
    .attr("stroke", "#334155")
    .attr("stroke-width", 1.5)
    .attr("stroke-dasharray", "4 3");

  const labelG = sliceG
    .filter((d) => !!d.label)
    .append("g")
    .attr("class", "slice-label")
    .attr("cursor", "pointer");

  labelG
    .append("rect")
    .attr("x", (d) => d.labelX - d.labelW / 2)
    .attr("y", (d) => d.labelY)
    .attr("width", (d) => d.labelW)
    .attr("height", (d) => d.labelH)
    .attr("rx", 4)
    .attr("ry", 4)
    .attr("fill", "#f1f5f9")
    .attr("stroke", "#cbd5e1")
    .attr("stroke-width", 1);

  labelG
    .append("text")
    .attr("x", (d) => d.labelX)
    .attr("y", (d) => d.labelY + d.labelH / 2 + 1)
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "middle")
    .attr("font-weight", 600)
    .attr("font-size", 11)
    .attr("fill", "#475569")
    .attr("text-decoration", "underline")
    .text((d) => d.label);

  // --- Edges --------------------------------------------------------------
  // Use the layout's edge list (expanded with duplicate-bound rewrites)
  // rather than the raw parsed edges.
  const edgeData = L.edges
    .map((e) => ({
      id: `${e.from}->${e.to}`,
      from: L.pos.get(e.from),
      to: L.pos.get(e.to),
      selfLoop: e.from === e.to,
    }))
    .filter((d) => d.from && d.to);

  // Assign port positions so edges sharing a node side don't overlap.
  // For each node+side, collect edges, sort by the other endpoint's x,
  // then distribute evenly across the side (with padding at the edges).
  assignEdgePorts(edgeData);

  gEdges
    .selectAll("path.edge")
    .data(edgeData, (d) => d.id)
    .join("path")
    .attr("class", "edge")
    .attr("data-from", (d) => d.from.el.id)
    .attr("data-to", (d) => d.to.el.id)
    .attr("data-from-port", (d) => d.fromPort)
    .attr("data-to-port", (d) => d.toPort)
    .attr("fill", "none")
    .attr("stroke", "#555")
    .attr("stroke-width", 1.25)
    .attr("marker-end", "url(#em-arrow)")
    .attr("d", (d) => edgePath(d));

  // --- Nodes --------------------------------------------------------------
  const HEADING_H = L.NODE_H_BASE;
  const FIELD_LINE_H = 16;

  // Use the layout's element list (expanded with read-model duplicates)
  // rather than the raw parsed elements.
  const nodeData = L.elements
    .map((el) => ({ el, ...L.pos.get(el.id) }))
    .filter((d) => d.x != null);

  // Map each node id to the space-separated set of slice ids it belongs to,
  // so slice membership is discoverable from the DOM for interactive
  // filtering. A fan-in read model gets duplicated into stubs (id__dup_N);
  // those inherit their original's slice membership so filtering a slice
  // that owns the read model dims its duplicate stubs too.
  const nodeSliceIds = new Map();
  for (const s of model.slices || []) {
    for (const id of s.nodeIds) {
      if (!nodeSliceIds.has(id)) nodeSliceIds.set(id, new Set());
      nodeSliceIds.get(id).add(s.id);
    }
  }
  const sliceIdsAttr = (el) => {
    const own = nodeSliceIds.get(el.id);
    const orig = el.originalId ? nodeSliceIds.get(el.originalId) : null;
    if (!own && !orig) return null;
    const merged = new Set([...(own || []), ...(orig || [])]);
    return merged.size ? [...merged].join(" ") : null;
  };

  const nodeG = gNodes
    .selectAll("g.node")
    .data(nodeData, (d) => d.el.id)
    .join("g")
    .attr("class", (d) => `node node-${d.el.kind}`)
    .attr("data-node-id", (d) => d.el.id)
    .attr("data-slice-ids", (d) => sliceIdsAttr(d.el))
    .attr("data-x", (d) => d.x)
    .attr("data-y", (d) => d.y)
    .attr("data-w", (d) => d.w)
    .attr("data-h", (d) => d.h)
    .attr("transform", (d) => `translate(${d.x},${d.y})`);

  // Main rect (full height including fields section).
  nodeG
    .append("rect")
    .attr("class", "node-bg")
    .attr("width", (d) => d.w)
    .attr("height", (d) => d.h)
    .attr("rx", (d) => (d.el.kind === "readModel" ? 14 : 4))
    .attr("ry", (d) => (d.el.kind === "readModel" ? 14 : 4))
    .attr("fill", (d) =>
      d.el.isDuplicate && d.el.kind === "readModel"
        ? "#bbf7d0"
        : NODE_STYLES[d.el.kind].fill
    )
    .attr("stroke", (d) => NODE_STYLES[d.el.kind].stroke)
    .attr("stroke-width", 1.5)
    .attr("stroke-dasharray", (d) =>
      d.el.isDuplicate ? "2 3" : NODE_STYLES[d.el.kind].dash
    );

  // UI screen-line glyph.
  nodeG
    .filter((d) => d.el.kind === "ui")
    .append("line")
    .attr("x1", 8)
    .attr("y1", 10)
    .attr("x2", (d) => d.w - 8)
    .attr("y2", 10)
    .attr("stroke", "#94a3b8");

  // Automation gear image: fills the area below the label strip. The image
  // preserves its 1:1 aspect ratio centered within the box, so wide
  // automation nodes show a square gear with horizontal whitespace.
  nodeG
    .filter((d) => d.el.kind === "automation")
    .append("image")
    .attr("href", AUTOMATION_IMG_URL)
    .attr("x", 4)
    .attr("y", AUTOMATION_LABEL_H)
    .attr("width", (d) => d.w - 8)
    .attr("height", (d) => d.h - AUTOMATION_LABEL_H - 4)
    .attr("preserveAspectRatio", "xMidYMid meet");

  // Wrapped labels — centered in the heading section, or in the top label
  // strip for automation nodes (so the label sits above the gear image).
  nodeG.each(function (d) {
    const hasFields = d.el.fields && d.el.fields.length > 0;
    const isAutomation = d.el.kind === "automation";
    const headH = isAutomation
      ? AUTOMATION_LABEL_H
      : hasFields
      ? HEADING_H
      : d.h;
    const lines = wrapLabel(d.el.label, 20);
    const lineH = 13;
    const startY = headH / 2 - ((lines.length - 1) * lineH) / 2;
    const text = d3
      .select(this)
      .append("text")
      .attr("text-anchor", "middle")
      .attr("fill", "#0f172a");
    text
      .selectAll("tspan")
      .data(lines)
      .join("tspan")
        .attr("x", d.w / 2)
        .attr("y", (_, i) => startY + i * lineH)
        .attr("dominant-baseline", "middle")
        .text((ln) => ln);
  });

  // --- Fields section (class-diagram style, below a divider) ------------
  const hasFields = (d) => d.el.fields && d.el.fields.length > 0;
  const hasReads = (d) =>
    d.el.kind === "command" && d.el.reads && d.el.reads.length > 0;
  const withFields = nodeG.filter(hasFields);
  const withReads = nodeG.filter(hasReads);
  const withSections = withFields; // chevron only governs the data section

  // Divider above the fields section.
  withFields
    .append("line")
    .attr("class", "field-divider")
    .attr("x1", 0)
    .attr("y1", HEADING_H)
    .attr("x2", (d) => d.w)
    .attr("y2", HEADING_H)
    .attr("stroke", (d) => NODE_STYLES[d.el.kind].stroke)
    .attr("stroke-width", 1);

  // Toggle chevron icon in the heading section.
  // Stop propagation so the click doesn't fall through to the chevron's own
  // handler and re-toggle. (The chevron is a <g> sibling of the rect.)
  const chevronG = withSections
    .append("g")
    .attr("class", "toggle-indicator")
    .attr("transform", (d) => `translate(${d.w - 16},${HEADING_H - 16})`);

  chevronG
    .append("circle")
    .attr("cx", 5)
    .attr("cy", 5)
    .attr("r", 7)
    .attr("fill", "rgba(0,0,0,0.06)")
    .attr("stroke", "none");

  // Down-pointing chevron path (expanded state).
  chevronG
    .append("path")
    .attr("class", "chevron-path")
    .attr("d", "M0,2 L5,8 L10,2")
    .attr("fill", "none")
    .attr("stroke", "#4b5563")
    .attr("stroke-width", 1.5)
    .attr("stroke-linecap", "round")
    .attr("stroke-linejoin", "round");

  // Fields group containing all field text lines.
  const fieldsG = withFields
    .append("g")
    .attr("class", "fields-section")
    .attr("transform", `translate(0,${HEADING_H})`);

  fieldsG.each(function (d) {
    const g = d3.select(this);
    d.el.fields.forEach((f, i) => {
      g.append("text")
        .attr("x", 8)
        .attr("y", 4 + (i + 1) * FIELD_LINE_H - 3)
        .attr("fill", "#374151")
        .attr("font-size", 10)
        .attr("font-weight", f.axis ? 600 : null)
        .text(fieldText(f));
    });
  });

  // Reads tags: each `reads [...]` entry on a command renders as a small
  // tag (left-pointing notch, "string hole" near the point, label to the
  // right) overlaid in the upper-right of the command box. Tags stack
  // vertically when there's more than one. They sit above the fields
  // section so the chevron's collapse never hides them.
  const TAG_H = 18;
  const TAG_NOTCH = 9;
  const TAG_HOLE_R = 2.2;
  const TAG_HOLE_GAP = 6;
  const TAG_LEFT_TEXT_PAD = 5;
  const TAG_RIGHT_TEXT_PAD = 6;
  const TAG_TOP = 6;
  const TAG_GAP = 3;
  const TAG_RIGHT_INSET = 6;
  const TAG_CHAR_W = 6.5;

  // Resolve each `reads` id to the referenced element's display label.
  const labelById = new Map(L.elements.map((e) => [e.id, e.label]));

  withReads.each(function (d) {
    const tagsG = d3.select(this).append("g").attr("class", "reads-tags");

    // Measure each read's actual rendered text width by appending an
    // off-screen <text> element and reading getComputedTextLength().
    // This avoids the per-character heuristic over-estimating tag widths
    // for labels that contain spaces or narrow characters (issue #2).
    const measured = d.el.reads.map((r) => {
      const txt = labelById.get(r) || r;
      const probe = tagsG
        .append("text")
        .attr("font-size", 10)
        .attr("visibility", "hidden")
        .text(txt);
      const measuredW = probe.node().getComputedTextLength() || 0;
      probe.remove();
      // Fall back to the heuristic if measurement fails (detached SVG, etc.).
      const textW = measuredW > 0 ? measuredW : txt.length * TAG_CHAR_W;
      return { txt, textW };
    });

    // All tags within one command share the width of the widest entry so
    // their notches and right edges line up cleanly.
    let uniformTagW = 0;
    for (const m of measured) {
      const w =
        TAG_NOTCH + TAG_HOLE_GAP + TAG_HOLE_R + TAG_LEFT_TEXT_PAD +
        m.textW + TAG_RIGHT_TEXT_PAD;
      if (w > uniformTagW) uniformTagW = w;
    }

    // Anchor the tag column to just past the centered title's right edge.
    // The tag block extends rightward from there, overflowing the command
    // box if the labels are long. The layout pass already pushes any
    // affected next-column element further right so the tag isn't hidden.
    const LABEL_CHAR_W_LOCAL = 7;
    const lines = wrapLabel(d.el.label, 20);
    const labelMaxLen = lines.length
      ? Math.max(...lines.map((l) => l.length))
      : 0;
    const titleHalfW = (labelMaxLen * LABEL_CHAR_W_LOCAL) / 2;
    const TAG_LEFT_GAP = 8;
    const tagX = d.w / 2 + titleHalfW + TAG_LEFT_GAP;

    measured.forEach(({ txt }, i) => {
      const y = TAG_TOP + i * (TAG_H + TAG_GAP);
      const tg = tagsG.append("g").attr("transform", `translate(${tagX},${y})`);
      const path =
        `M ${TAG_NOTCH},0 L ${uniformTagW},0 L ${uniformTagW},${TAG_H} ` +
        `L ${TAG_NOTCH},${TAG_H} L 0,${TAG_H / 2} Z`;
      tg.append("path")
        .attr("d", path)
        .attr("fill", "#fef3c7")
        .attr("stroke", "#854d0e")
        .attr("stroke-width", 1);
      tg.append("circle")
        .attr("cx", TAG_NOTCH + TAG_HOLE_GAP)
        .attr("cy", TAG_H / 2)
        .attr("r", TAG_HOLE_R)
        .attr("fill", "none")
        .attr("stroke", "#854d0e")
        .attr("stroke-width", 1);
      tg.append("text")
        .attr("x", TAG_NOTCH + TAG_HOLE_GAP + TAG_HOLE_R + TAG_LEFT_TEXT_PAD)
        .attr("y", TAG_H / 2 + 0.5)
        .attr("dominant-baseline", "middle")
        .attr("font-size", 10)
        .attr("fill", "#3f2502")
        .text(txt);
    });
  });

  // Click-to-collapse: use inline onclick so it survives Mermaid's DOM handling.
  // Register the toggle function globally so inline handlers can call it.
  if (typeof globalThis.__emToggleFields === "undefined") {
    // Read a node's current visual bounds from its data attributes + rect height.
    function nodeRect(g) {
      const rect = g.querySelector(".node-bg");
      return {
        x: +g.dataset.x,
        y: +g.dataset.y,
        w: +g.dataset.w,
        h: +rect.getAttribute("height"),
      };
    }

    // Determine which side of a node an edge connects to (mirrors edgeSide).
    function domEdgeSide(nodePos, otherPos) {
      const aCy = nodePos.y + nodePos.h / 2;
      const bCy = otherPos.y + otherPos.h / 2;
      if (Math.abs(aCy - bCy) < 10) {
        const aCx = nodePos.x + nodePos.w / 2;
        const bCx = otherPos.x + otherPos.w / 2;
        return bCx >= aCx ? "right" : "left";
      }
      return aCy < bCy ? "bottom" : "top";
    }

    function domPortXY(pos, side, port) {
      const PAD = 12;
      switch (side) {
        case "bottom": return { x: pos.x + PAD + (pos.w - 2 * PAD) * port, y: pos.y + pos.h };
        case "top":    return { x: pos.x + PAD + (pos.w - 2 * PAD) * port, y: pos.y };
        case "right":  return { x: pos.x + pos.w, y: pos.y + PAD + (pos.h - 2 * PAD) * port };
        case "left":   return { x: pos.x,         y: pos.y + PAD + (pos.h - 2 * PAD) * port };
      }
    }

    // Recompute a single edge path from DOM-derived positions + stored ports.
    function recomputeEdge(pathEl) {
      const svgRoot = pathEl.closest("svg");
      const fromId = pathEl.dataset.from;
      const toId = pathEl.dataset.to;
      const fromPort = +pathEl.dataset.fromPort;
      const toPort = +pathEl.dataset.toPort;
      const fromG = svgRoot.querySelector(`.node[data-node-id="${fromId}"]`);
      const toG = svgRoot.querySelector(`.node[data-node-id="${toId}"]`);
      if (!fromG || !toG) return;

      const a = nodeRect(fromG);
      const b = nodeRect(toG);

      if (fromId === toId) {
        const x = a.x + a.w;
        const y1 = a.y + a.h * 0.3;
        const y2 = a.y + a.h * 0.7;
        const cx = x + 24;
        pathEl.setAttribute("d", `M${x},${y1} C${cx},${y1} ${cx},${y2} ${x},${y2}`);
        return;
      }

      const fromSide = domEdgeSide(a, b);
      const toSide = domEdgeSide(b, a);
      const src = domPortXY(a, fromSide, fromPort);
      const tgt = domPortXY(b, toSide, toPort);
      const sx = src.x, sy = src.y, tx = tgt.x, ty = tgt.y;

      if (fromSide === "left" || fromSide === "right") {
        const dx = Math.abs(tx - sx) * 0.4;
        pathEl.setAttribute("d",
          `M${sx},${sy} C${sx + (tx > sx ? dx : -dx)},${sy} ${tx + (tx > sx ? -dx : dx)},${ty} ${tx},${ty}`);
        return;
      }

      const dy = Math.abs(ty - sy);
      const tension = Math.min(dy * 0.5, 40);
      const signY = ty > sy ? 1 : -1;
      pathEl.setAttribute("d",
        `M${sx},${sy} C${sx},${sy + signY * tension} ${tx},${ty - signY * tension} ${tx},${ty}`);
    }

    globalThis.__emToggleFields = function (nodeGroup) {
      const g = nodeGroup.closest(".node");
      const collapsibles = g.querySelectorAll(
        ".fields-section, .field-divider"
      );
      const chevron = g.querySelector(".toggle-indicator");
      const bgRect = g.querySelector(".node-bg");
      // Use any one of the collapsibles to detect current state.
      const probe = collapsibles[0];
      const isVisible = probe && probe.style.display !== "none";

      if (isVisible) {
        collapsibles.forEach((el) => (el.style.display = "none"));
        bgRect.setAttribute("height", bgRect.dataset.headingH);
        chevron.querySelector(".chevron-path").setAttribute("d", "M2,0 L8,5 L2,10");
      } else {
        collapsibles.forEach((el) => (el.style.display = ""));
        bgRect.setAttribute("height", bgRect.dataset.fullH);
        chevron.querySelector(".chevron-path").setAttribute("d", "M0,2 L5,8 L10,2");
      }

      // Recompute edges connected to this node.
      const nodeId = g.dataset.nodeId;
      const svgRoot = g.closest("svg");
      svgRoot.querySelectorAll(`path.edge[data-from="${nodeId}"], path.edge[data-to="${nodeId}"]`)
        .forEach(recomputeEdge);
    };
  }

  // Store heights as data attributes and set inline onclick.
  withSections.each(function (d) {
    const g = d3.select(this);
    g.select(".node-bg")
      .attr("data-heading-h", HEADING_H)
      .attr("data-full-h", d.h);
    g.style("cursor", "pointer")
      .attr("onclick", "__emToggleFields(evt.target)");
  });

  // --- Slice selection ----------------------------------------------------
  // One slice visible at a time. 24 always-on dashed boxes over 48 nodes read
  // as noise, and every producer/consumer seam makes two of them overlap by
  // exactly one column, so the bands stay hidden until a slice is selected.
  // The always-visible part is the label chip.
  //
  // Handlers are inline attributes, not addEventListener: Mermaid serializes
  // the SVG before inserting it, which drops JS properties and listeners.
  // Same reason `__emToggleFields` is installed on globalThis.
  if (typeof globalThis.__emSelectSlice === "undefined") {
    globalThis.__emSelectSlice = function (el, sliceId) {
      const svgRoot = el.closest ? el.closest("svg") : el;
      if (!svgRoot) return;
      if (sliceId === "__toggle") {
        const cur = svgRoot.getAttribute("data-pinned-slice") || "";
        const want = el.closest("g.slice").getAttribute("data-slice-id");
        sliceId = cur === want ? "" : want;
        svgRoot.setAttribute("data-pinned-slice", sliceId);
      }
      const active = sliceId || svgRoot.getAttribute("data-pinned-slice") || "";
      // The map lives in one attribute VALUE, not in per-node attribute names:
      // Mermaid serializes the SVG and the HTML parser lowercases attribute
      // names on re-parse, which would mangle ids like `addRoom`.
      let map = svgRoot.__emSliceMap;
      if (!map) {
        try {
          map = JSON.parse(svgRoot.getAttribute("data-slice-members") || "{}");
        } catch { map = {}; }
        svgRoot.__emSliceMap = map;
      }
      const memberOf = (id) =>
        (id && (map[id] || map[id.split("__dup")[0]])) || [];
      svgRoot.querySelectorAll("g.slice").forEach((g) => {
        const on = active && g.getAttribute("data-slice-id") === active;
        const bands = g.querySelector(".slice-bands");
        if (bands) bands.setAttribute("opacity", on ? 1 : 0);
        const chip = g.querySelector(".slice-label rect");
        if (chip) {
          chip.setAttribute("fill", on ? "#334155" : "#f1f5f9");
          chip.setAttribute("stroke", on ? "#334155" : "#cbd5e1");
        }
        const txt = g.querySelector(".slice-label text");
        if (txt) txt.setAttribute("fill", on ? "#ffffff" : "#475569");
      });
      svgRoot.querySelectorAll("g.node").forEach((g) => {
        if (!active) { g.setAttribute("opacity", 1); return; }
        g.setAttribute(
          "opacity",
          memberOf(g.getAttribute("data-node-id")).includes(active) ? 1 : 0.2
        );
      });
      svgRoot.querySelectorAll("path.edge").forEach((e) => {
        if (!active) { e.setAttribute("opacity", 1); return; }
        const f = memberOf(e.getAttribute("data-from"));
        const t = memberOf(e.getAttribute("data-to"));
        e.setAttribute(
          "opacity",
          f.includes(active) && t.includes(active) ? 1 : 0.12
        );
      });
    };
  }

  // Node → slices, stamped onto the SVG root so it survives serialization.
  {
    const nodeToSlices = new Map();
    for (const [sliceId, ids] of L.sliceMembers || []) {
      for (const id of ids) {
        if (!nodeToSlices.has(id)) nodeToSlices.set(id, []);
        nodeToSlices.get(id).push(sliceId);
      }
    }
    svg.attr(
      "data-slice-members",
      JSON.stringify(Object.fromEntries(nodeToSlices))
    );
    svg.attr("data-pinned-slice", "");

    sliceG
      .select(".slice-label")
      .attr("onmouseenter", (d) => `__emSelectSlice(this,'${d.sliceId}')`)
      .attr("onmouseleave", "__emSelectSlice(this,'')");

    nodeG
      .filter((d) => nodeToSlices.has(d.el.id))
      .attr(
        "onmouseenter",
        (d) => `__emSelectSlice(this,'${nodeToSlices.get(d.el.id)[0]}')`
      )
      .attr("onmouseleave", "__emSelectSlice(this,'')");
  }
}

// For each node side (top, bottom, left, right), collect all edges that
// connect there, sort them by the position of the other endpoint so they
// don't cross, then assign evenly-spaced port fractions (0..1) along the
// side. Each edge gets `fromPort` and `toPort` stored on it.
function assignEdgePorts(edgeData) {
  // Determine which side of a node an edge connects to.
  function edgeSide(nodePos, otherPos) {
    const aCy = nodePos.y + nodePos.h / 2;
    const bCy = otherPos.y + otherPos.h / 2;
    if (Math.abs(aCy - bCy) < 10) {
      const aCx = nodePos.x + nodePos.w / 2;
      const bCx = otherPos.x + otherPos.w / 2;
      return bCx >= aCx ? "right" : "left";
    }
    return aCy < bCy ? "bottom" : "top";
  }

  // Collect edges per (node, side).
  const buckets = new Map(); // key: "nodeId|side" -> [{edge, role, otherPos}]
  for (const d of edgeData) {
    if (d.selfLoop) { d.fromPort = 0.5; d.toPort = 0.5; continue; }

    const fromSide = edgeSide(d.from, d.to);
    const toSide = edgeSide(d.to, d.from);

    const fk = d.from.el.id + "|" + fromSide;
    const tk = d.to.el.id + "|" + toSide;
    if (!buckets.has(fk)) buckets.set(fk, []);
    if (!buckets.has(tk)) buckets.set(tk, []);
    buckets.get(fk).push({ edge: d, role: "from", otherPos: d.to });
    buckets.get(tk).push({ edge: d, role: "to", otherPos: d.from });
  }

  // Sort each bucket and assign evenly-spaced port fractions.
  for (const [key, entries] of buckets) {
    const side = key.split("|")[1];
    // Sort by the other node's position along the edge axis so lines
    // don't cross: for top/bottom edges sort by x, for left/right by y.
    if (side === "top" || side === "bottom") {
      entries.sort((a, b) => (a.otherPos.x + a.otherPos.w / 2) - (b.otherPos.x + b.otherPos.w / 2));
    } else {
      entries.sort((a, b) => (a.otherPos.y + a.otherPos.h / 2) - (b.otherPos.y + b.otherPos.h / 2));
    }
    const n = entries.length;
    entries.forEach((e, i) => {
      const frac = (i + 1) / (n + 1); // evenly spaced, never at 0 or 1
      if (e.role === "from") e.edge.fromPort = frac;
      else e.edge.toPort = frac;
    });
  }
}

// Convert a port fraction (0..1) to an absolute coordinate on a node side.
function portXY(pos, side, port) {
  const PAD = 12; // keep ports away from corners
  switch (side) {
    case "bottom": return { x: pos.x + PAD + (pos.w - 2 * PAD) * port, y: pos.y + pos.h };
    case "top":    return { x: pos.x + PAD + (pos.w - 2 * PAD) * port, y: pos.y };
    case "right":  return { x: pos.x + pos.w, y: pos.y + PAD + (pos.h - 2 * PAD) * port };
    case "left":   return { x: pos.x,         y: pos.y + PAD + (pos.h - 2 * PAD) * port };
  }
}

function edgeSide(nodePos, otherPos) {
  const aCy = nodePos.y + nodePos.h / 2;
  const bCy = otherPos.y + otherPos.h / 2;
  if (Math.abs(aCy - bCy) < 10) {
    const aCx = nodePos.x + nodePos.w / 2;
    const bCx = otherPos.x + otherPos.w / 2;
    return bCx >= aCx ? "right" : "left";
  }
  return aCy < bCy ? "bottom" : "top";
}

function edgePath(d) {
  const a = d.from;
  const b = d.to;

  if (d.selfLoop) {
    const x = a.x + a.w;
    const y1 = a.y + a.h * 0.3;
    const y2 = a.y + a.h * 0.7;
    const cx = x + 24;
    return `M${x},${y1} C${cx},${y1} ${cx},${y2} ${x},${y2}`;
  }

  const fromSide = edgeSide(a, b);
  const toSide = edgeSide(b, a);
  const src = portXY(a, fromSide, d.fromPort);
  const tgt = portXY(b, toSide, d.toPort);
  const sx = src.x, sy = src.y, tx = tgt.x, ty = tgt.y;

  if (fromSide === "left" || fromSide === "right") {
    // Horizontal bezier.
    const dx = Math.abs(tx - sx) * 0.4;
    return `M${sx},${sy} C${sx + (tx > sx ? dx : -dx)},${sy} ${tx + (tx > sx ? -dx : dx)},${ty} ${tx},${ty}`;
  }

  // Vertical bezier.
  const dy = Math.abs(ty - sy);
  const tension = Math.min(dy * 0.5, 40);
  const signY = ty > sy ? 1 : -1;
  return `M${sx},${sy} C${sx},${sy + signY * tension} ${tx},${ty - signY * tension} ${tx},${ty}`;
}

// ── Interactive slice filtering ────────────────────────────────────────────
// Dim everything that isn't part of the selected slice(s), leaving the layout
// untouched so nodes never jump around. Operates purely on the rendered DOM
// (via the `data-slice-id`/`data-slice-ids`/`data-from`/`data-to` attributes
// stamped by `drawInto`), so it works for both the standalone renderer and the
// Mermaid adapter, and can be driven by any host page.
//
//   svgEl          — the <svg> element (or a d3 selection of it) to filter.
//   activeSliceIds — an array/Set of slice ids to keep highlighted. Pass an
//                    empty array/Set, null, or undefined to clear the filter
//                    (restore every element to full visibility).
const SLICE_DIM_OPACITY = 0.12;

export function listSliceIds(svgEl) {
  const el = svgEl && svgEl.node ? svgEl.node() : svgEl;
  if (!el) return [];
  const seen = new Map();
  el.querySelectorAll("g.slice[data-slice-id]").forEach((g) => {
    const id = g.getAttribute("data-slice-id");
    if (id && !seen.has(id)) {
      seen.set(id, g.getAttribute("data-slice-label") || id);
    }
  });
  return [...seen].map(([id, label]) => ({ id, label }));
}

export function applySliceFilter(svgEl, activeSliceIds) {
  const el = svgEl && svgEl.node ? svgEl.node() : svgEl;
  if (!el) return;

  const active =
    activeSliceIds instanceof Set ? activeSliceIds : new Set(activeSliceIds || []);
  const filtering = active.size > 0;

  const setDim = (node, dim) => {
    node.style.opacity = dim ? String(SLICE_DIM_OPACITY) : "";
    node.style.transition = "opacity 0.15s ease";
  };

  // Nodes: active when any of their slice ids is selected. Track which node
  // ids end up visible so edges can be gated on both endpoints being visible.
  const visibleNodeIds = new Set();
  el.querySelectorAll("g.node[data-node-id]").forEach((g) => {
    if (!filtering) { setDim(g, false); visibleNodeIds.add(g.getAttribute("data-node-id")); return; }
    const ids = (g.getAttribute("data-slice-ids") || "").split(/\s+/).filter(Boolean);
    const isActive = ids.some((id) => active.has(id));
    setDim(g, !isActive);
    if (isActive) visibleNodeIds.add(g.getAttribute("data-node-id"));
  });

  // Edges: visible only when both endpoints are visible.
  el.querySelectorAll("path.edge").forEach((p) => {
    if (!filtering) { setDim(p, false); return; }
    const from = p.getAttribute("data-from");
    const to = p.getAttribute("data-to");
    setDim(p, !(visibleNodeIds.has(from) && visibleNodeIds.has(to)));
  });

  // Slice boxes: highlight the selected ones, dim the rest.
  el.querySelectorAll("g.slice[data-slice-id]").forEach((g) => {
    if (!filtering) { setDim(g, false); return; }
    setDim(g, !active.has(g.getAttribute("data-slice-id")));
  });
}

function wrapLabel(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

export { parseEventModel, computeRanks, layoutEventModel };
