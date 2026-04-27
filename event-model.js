import * as d3 from "d3";

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

function parseEventModel(src) {
  // The `:<lane>` qualifier on domainEvent is optional in DCB models (no aggregates).
  // The optional `reads [a, b, c]` clause on commands lists past event types the
  // command must consult for consistency — a directive to the event-sourcing
  // framework, not a flow edge.
  const elementRe =
    /^(ui|command|domainEvent|readModel|automation)(?::(\w+))?\s+(\w+)(?:\s*\["([^"]*)"\])?(?:\s+reads\s*\[([^\]]*)\])?\s*(\{)?\s*$/;
  const edgeRe = /^(\w+)\s*-->\s*(\w+)$/;
  const actorRe = /^actor\s+(\w+)$/;
  const aggRe = /^aggregate\s+(\w+)$/;
  const fieldRe = /^(\w+)\s*:\s*(\w+)$/;
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
          if (fm) fields.push({ name: fm[1], type: fm[2] });
        }
      }
      const reads = readsList
        ? readsList.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      elements.push({ id, kind, lane: lane || null, label: label || id, fields, reads });
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

function layoutEventModel(model) {
  const { actors, aggregates, elements } = model;
  const rank = computeRanks(elements, model.edges);

  // DCB models declare events without an aggregate qualifier. When any such
  // event exists, synthesize a single "Events" lane below the time lane to
  // hold them. Aggregate-qualified events still go to their named lane.
  const hasUnqualifiedEvents = elements.some(
    (el) => el.kind === "domainEvent" && !el.lane
  );

  const lanes = [
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
    return "time";
  };

  // Bucket into (lane, col); multiple elements in the same cell stack vertically.
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
        const fw = (f.name.length + 2 + f.type.length) * FIELD_CHAR_W + FIELD_PAD;
        if (fw > maxFieldW) maxFieldW = fw;
      }
    }

    // Width needed for the widest reads line (prefixed with "« ").
    let maxReadW = 0;
    if (el.reads && el.reads.length > 0) {
      for (const r of el.reads) {
        const rw = (r.length + 2) * FIELD_CHAR_W + FIELD_PAD;
        if (rw > maxReadW) maxReadW = rw;
      }
    }

    return Math.max(NODE_W_MIN, maxLabelW, maxFieldW, maxReadW);
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

  // Per-element height: base heading + optional fields section + optional reads section.
  const nodeH = (el) => {
    const hasFields = el.fields && el.fields.length > 0;
    const hasReads = el.reads && el.reads.length > 0;
    if (!hasFields && !hasReads) return NODE_H_BASE;
    let h = NODE_H_BASE;
    if (hasFields) h += el.fields.length * FIELD_LINE_H + 4;
    if (hasReads) h += el.reads.length * FIELD_LINE_H + 4;
    return h;
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
  const totalH = y + MARGIN_B;

  let maxCol = 0;
  for (const v of rank.values()) if (v > maxCol) maxCol = v;
  const totalW = MARGIN_L + (maxCol + 1) * COL_W + MARGIN_R;

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
    const cx = MARGIN_L + col * COL_W + COL_W / 2;
    const nx = cx - NODE_W / 2;
    for (const el of arr) {
      const h = nodeH(el);
      pos.set(el.id, { el, x: nx, y: curY, w: NODE_W, h });
      curY += h + SUB_GAP;
    }
  }

  // Compute bounding boxes for each slice from its member nodes.
  const SLICE_PAD = 10;
  const SLICE_LABEL_H = 20;
  const sliceRects = [];
  for (const s of model.slices || []) {
    const memberPositions = s.nodeIds.map((id) => pos.get(id)).filter(Boolean);
    if (memberPositions.length === 0) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of memberPositions) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x + p.w > maxX) maxX = p.x + p.w;
      if (p.y + p.h > maxY) maxY = p.y + p.h;
    }
    sliceRects.push({
      id: s.id,
      label: s.label,
      x: minX - SLICE_PAD,
      y: minY - SLICE_PAD - SLICE_LABEL_H,
      w: (maxX - minX) + SLICE_PAD * 2,
      h: (maxY - minY) + SLICE_PAD * 2 + SLICE_LABEL_H,
      labelH: SLICE_LABEL_H,
    });
  }

  return { lanes: laneRects, pos, edges: model.edges, elements, slices: sliceRects, totalW, totalH, MARGIN_L, NODE_H_BASE };
}

const NODE_STYLES = {
  ui:          { fill: "#ffffff", stroke: "#475569", dash: null },
  command:     { fill: "#60a5fa", stroke: "#1e3a8a", dash: null },
  domainEvent: { fill: "#fb923c", stroke: "#7c2d12", dash: null },
  readModel:   { fill: "#86efac", stroke: "#14532d", dash: null },
  automation:  { fill: "#ffffff", stroke: "#475569", dash: "4 2" },
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
  const sliceG = gSlices
    .selectAll("g.slice")
    .data(L.slices || [], (d) => d.id)
    .join("g")
    .attr("class", "slice");

  sliceG
    .append("rect")
    .attr("x", (d) => d.x)
    .attr("y", (d) => d.y)
    .attr("width", (d) => d.w)
    .attr("height", (d) => d.h)
    .attr("rx", 6)
    .attr("ry", 6)
    .attr("fill", "none")
    .attr("stroke", "#64748b")
    .attr("stroke-width", 1.5)
    .attr("stroke-dasharray", "4 3")
    .attr("pointer-events", "stroke")
    .attr("cursor", "pointer")
    .attr("onmouseenter", "this.setAttribute('stroke-width','3.5');this.setAttribute('stroke','#334155')")
    .attr("onmouseleave", "this.setAttribute('stroke-width','1.5');this.setAttribute('stroke','#64748b')");

  sliceG
    .append("text")
    .attr("x", (d) => d.x + d.w / 2)
    .attr("y", (d) => d.y + d.labelH / 2 + 1)
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "middle")
    .attr("font-weight", 600)
    .attr("fill", "#475569")
    .text((d) => d.label);

  // --- Edges --------------------------------------------------------------
  const edgeData = model.edges
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

  const nodeData = model.elements
    .map((el) => ({ el, ...L.pos.get(el.id) }))
    .filter((d) => d.x != null);

  const nodeG = gNodes
    .selectAll("g.node")
    .data(nodeData, (d) => d.el.id)
    .join("g")
    .attr("class", (d) => `node node-${d.el.kind}`)
    .attr("data-node-id", (d) => d.el.id)
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
    .attr("fill", (d) => NODE_STYLES[d.el.kind].fill)
    .attr("stroke", (d) => NODE_STYLES[d.el.kind].stroke)
    .attr("stroke-width", 1.5)
    .attr("stroke-dasharray", (d) => NODE_STYLES[d.el.kind].dash);

  // UI screen-line glyph.
  nodeG
    .filter((d) => d.el.kind === "ui")
    .append("line")
    .attr("x1", 8)
    .attr("y1", 10)
    .attr("x2", (d) => d.w - 8)
    .attr("y2", 10)
    .attr("stroke", "#94a3b8");

  // Automation gear glyph.
  nodeG
    .filter((d) => d.el.kind === "automation")
    .append("text")
    .attr("x", (d) => d.w - 10)
    .attr("y", 16)
    .attr("text-anchor", "end")
    .attr("font-size", 12)
    .text("⚙");

  // Wrapped labels — centered in the heading section.
  nodeG.each(function (d) {
    const hasFields = d.el.fields && d.el.fields.length > 0;
    const hasReads = d.el.reads && d.el.reads.length > 0;
    const headH = hasFields || hasReads ? HEADING_H : d.h;
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

  // --- Fields & reads sections (class-diagram style, below dividers) -----
  const hasFields = (d) => d.el.fields && d.el.fields.length > 0;
  const hasReads = (d) => d.el.reads && d.el.reads.length > 0;
  const hasSections = (d) => hasFields(d) || hasReads(d);
  const withSections = nodeG.filter(hasSections);
  const withFields = nodeG.filter(hasFields);
  const withReads = nodeG.filter(hasReads);

  // Y-offset where the reads section starts (after heading + optional fields).
  const readsOffsetOf = (d) =>
    HEADING_H + (hasFields(d) ? d.el.fields.length * FIELD_LINE_H + 4 : 0);

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

  // Divider above the reads section.
  withReads
    .append("line")
    .attr("class", "reads-divider")
    .attr("x1", 0)
    .attr("y1", readsOffsetOf)
    .attr("x2", (d) => d.w)
    .attr("y2", readsOffsetOf)
    .attr("stroke", (d) => NODE_STYLES[d.el.kind].stroke)
    .attr("stroke-width", 1);

  // Toggle chevron icon in the heading section.
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
        .text(`${f.name}: ${f.type}`);
    });
  });

  // Reads group: each entry prefixed with "« " to indicate a consume.
  const readsG = withReads
    .append("g")
    .attr("class", "reads-section")
    .attr("transform", (d) => `translate(0,${readsOffsetOf(d)})`);

  readsG.each(function (d) {
    const g = d3.select(this);
    d.el.reads.forEach((r, i) => {
      g.append("text")
        .attr("x", 8)
        .attr("y", 4 + (i + 1) * FIELD_LINE_H - 3)
        .attr("fill", "#475569")
        .attr("font-size", 10)
        .attr("font-style", "italic")
        .text(`« ${r}`);
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
        ".fields-section, .reads-section, .field-divider, .reads-divider"
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
