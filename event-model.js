import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

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
  const elementRe =
    /^(ui|command|domainEvent|readModel|automation)(?::(\w+))?\s+(\w+)(?:\s*\["([^"]*)"\])?$/;
  const edgeRe = /^(\w+)\s*-->\s*(\w+)$/;
  const actorRe = /^actor\s+(\w+)$/;
  const aggRe = /^aggregate\s+(\w+)$/;

  const actors = [];
  const aggregates = [];
  const elements = [];
  const edges = [];

  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "eventModel") continue;

    let m;
    if ((m = line.match(actorRe))) { actors.push(m[1]); continue; }
    if ((m = line.match(aggRe)))   { aggregates.push(m[1]); continue; }
    if ((m = line.match(elementRe))) {
      const [, kind, lane, id, label] = m;
      elements.push({ id, kind, lane: lane || null, label: label || id });
      continue;
    }
    if ((m = line.match(edgeRe))) {
      edges.push({ from: m[1], to: m[2] });
      continue;
    }
    // Unknown lines are ignored so the DSL can evolve without breaking render.
  }

  return { actors, aggregates, elements, edges };
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

  const lanes = [
    ...actors.map((a) => ({ key: "actor:" + a, title: a, kind: "actor" })),
    { key: "time", title: "Time", kind: "time" },
    ...aggregates.map((a) => ({ key: "agg:" + a, title: a, kind: "aggregate" })),
  ];
  const laneIndex = new Map(lanes.map((l, i) => [l.key, i]));

  const laneKeyOf = (el) => {
    if (el.kind === "ui" || el.kind === "automation") return "actor:" + el.lane;
    if (el.kind === "domainEvent") return "agg:" + el.lane;
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
  const COL_W = 170;
  const NODE_W = 140;
  const NODE_H = 54;
  const LANE_PAD = 14;
  const SUB_GAP = 8;

  const maxStack = new Map(lanes.map((l) => [l.key, 1]));
  for (const [k, arr] of cells) {
    const laneKey = k.split("|")[0];
    if (arr.length > maxStack.get(laneKey)) maxStack.set(laneKey, arr.length);
  }

  const laneRects = [];
  let y = MARGIN_T;
  for (const lane of lanes) {
    const n = maxStack.get(lane.key);
    const h = LANE_PAD * 2 + n * NODE_H + Math.max(0, n - 1) * SUB_GAP;
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
    const totalSubH = nSub * NODE_H + Math.max(0, nSub - 1) * SUB_GAP;
    const startY = lr.y + (lr.h - totalSubH) / 2;
    const cx = MARGIN_L + col * COL_W + COL_W / 2;
    const nx = cx - NODE_W / 2;
    arr.forEach((el, i) => {
      pos.set(el.id, { el, x: nx, y: startY + i * (NODE_H + SUB_GAP), w: NODE_W, h: NODE_H });
    });
  }

  return { lanes: laneRects, pos, edges: model.edges, elements, totalW, totalH, MARGIN_L };
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
  const L = layoutEventModel(model);

  // Start clean.
  const root = d3.select(target);
  root.selectAll("svg").remove();

  const svg = root
    .append("svg")
    .attr("xmlns", "http://www.w3.org/2000/svg")
    .attr("width", L.totalW)
    .attr("height", L.totalH)
    .attr("viewBox", `0 0 ${L.totalW} ${L.totalH}`)
    .attr("font-family", "system-ui, -apple-system, sans-serif")
    .attr("font-size", 12);

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
  const gLanes = svg.append("g").attr("class", "lanes");
  const gAxis  = svg.append("g").attr("class", "axis");
  const gEdges = svg.append("g").attr("class", "edges");
  const gNodes = svg.append("g").attr("class", "nodes");

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

  // --- Edges --------------------------------------------------------------
  const link = d3.linkHorizontal().x((p) => p[0]).y((p) => p[1]);

  const edgeData = model.edges
    .map((e) => ({
      id: `${e.from}->${e.to}`,
      from: L.pos.get(e.from),
      to: L.pos.get(e.to),
      selfLoop: e.from === e.to,
    }))
    .filter((d) => d.from && d.to);

  gEdges
    .selectAll("path.edge")
    .data(edgeData, (d) => d.id)
    .join("path")
    .attr("class", "edge")
    .attr("fill", "none")
    .attr("stroke", "#555")
    .attr("stroke-width", 1.25)
    .attr("marker-end", "url(#em-arrow)")
    .attr("d", (d) => edgePath(d, link));

  // --- Nodes --------------------------------------------------------------
  const nodeData = model.elements
    .map((el) => ({ el, ...L.pos.get(el.id) }))
    .filter((d) => d.x != null);

  const nodeG = gNodes
    .selectAll("g.node")
    .data(nodeData, (d) => d.el.id)
    .join("g")
    .attr("class", (d) => `node node-${d.el.kind}`)
    .attr("transform", (d) => `translate(${d.x},${d.y})`);

  nodeG
    .append("rect")
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

  // Wrapped labels — one <text> per node with one <tspan> per line.
  nodeG.each(function (d) {
    const lines = wrapLabel(d.el.label, 20);
    const lineH = 13;
    const startY = d.h / 2 - ((lines.length - 1) * lineH) / 2;
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

  return { svg: svg.node(), model, layout: L };
}

function edgePath(d, link) {
  if (d.selfLoop) {
    const x = d.from.x + d.from.w;
    const y1 = d.from.y + d.from.h * 0.3;
    const y2 = d.from.y + d.from.h * 0.7;
    const cx = x + 24;
    return `M${x},${y1} C${cx},${y1} ${cx},${y2} ${x},${y2}`;
  }
  const a = d.from;
  const b = d.to;
  const aCx = a.x + a.w / 2;
  const bCx = b.x + b.w / 2;
  const source = bCx >= aCx ? [a.x + a.w, a.y + a.h / 2] : [a.x, a.y + a.h / 2];
  const target = bCx >= aCx ? [b.x,       b.y + b.h / 2] : [b.x + b.w, b.y + b.h / 2];
  return link({ source, target });
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
