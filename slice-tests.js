import * as d3 from "d3";

// Slice Tests DSL → SVG renderer.
//
// Grammar:
//   sliceTests
//       test["<Title>"]
//           given
//               domainEvent["<Label>"]
//               readModel["<Label>"]
//               ...
//           when                       (optional — omit for state-view tests)
//               command["<Label>"]
//           then
//               domainEvent["<Label>"]
//               ...
//
// Each test renders as a self-contained card with its own Given / When / Then
// row labels on the left and items stacked horizontally to the right. Tests
// grid-pack into rows that fill the target width (read from the container's
// clientWidth at render time, defaulting to 1200). Item kinds match the
// event-model DSL exactly (domainEvent, externalEvent, command, readModel,
// automation, ui) and inherit the same colors and shapes.

function parseSliceTests(src) {
  const itemRe =
    /^(domainEvent|externalEvent|command|readModel|automation|ui)\s*\["([^"]*)"\]\s*$/;
  const testRe = /^test\s*\["([^"]*)"\]\s*$/;
  const lines = src.split(/\r?\n/);
  const indentOf = (raw) => raw.match(/^[\t ]*/)[0].length;

  const tests = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line === "sliceTests") { i++; continue; }

    const tm = line.match(testRe);
    if (tm) {
      const test = { title: tm[1] || "", given: [], when: [], then: [] };
      const testIndent = indentOf(raw);
      i++;
      let section = null;
      while (i < lines.length) {
        const r = lines[i];
        const l = r.trim();
        if (!l) { i++; continue; }
        if (indentOf(r) <= testIndent) break;
        if (l === "given" || l === "when" || l === "then") {
          section = l;
          i++;
          continue;
        }
        const im = l.match(itemRe);
        if (im && section) {
          test[section].push({ kind: im[1], label: im[2] });
          i++;
          continue;
        }
        // Unknown line inside a test — skip without breaking out.
        i++;
      }
      tests.push(test);
      continue;
    }
    i++;
  }
  return { tests };
}

function layoutSliceTests(model, options = {}) {
  const TARGET_W      = Math.max(360, options.targetWidth || 1200);

  const ITEM_W_MIN    = 110;
  const ITEM_H        = 56;
  const ITEM_GAP      = 10;
  const ROW_LABEL_W   = 64;
  const TEST_TITLE_H  = 32;
  const TEST_PAD      = 16;
  const ROW_PAD       = 10;
  const TEST_GAP      = 24;
  const MARGIN        = 20;
  const LABEL_CHAR_W  = 7;

  // Per test, compute its OWN size based on its content. Each test card is
  // sized to fit just what it contains — no uniform sizing across tests.
  const tests = model.tests.map((t) => {
    const allItems = [...t.given, ...t.when, ...t.then];
    let itemW = ITEM_W_MIN;
    for (const it of allItems) {
      const lines = wrapLabel(it.label, 14);
      const longest = Math.max(...lines.map((s) => s.length), 0);
      const w = longest * LABEL_CHAR_W + 24;
      if (w > itemW) itemW = w;
    }
    const maxItems = Math.max(t.given.length, t.when.length, t.then.length, 1);
    const cellW = maxItems * itemW + (maxItems - 1) * ITEM_GAP;
    const w = TEST_PAD * 2 + ROW_LABEL_W + cellW;
    const rowH = ITEM_H + ROW_PAD * 2;
    const h = TEST_PAD * 2 + TEST_TITLE_H + 3 * rowH;
    return { ...t, itemW, maxItems, cellW, w, h, rowH };
  });

  // Flex-wrap pack: place each test left-to-right; if the next test would
  // overflow the available width, wrap to a new row.
  const usableW = TARGET_W - MARGIN * 2;
  const grid = [[]];
  let rowW = 0;
  for (const t of tests) {
    const proposedW = rowW === 0 ? t.w : rowW + TEST_GAP + t.w;
    if (rowW > 0 && proposedW > usableW) {
      grid.push([t]);
      rowW = t.w;
    } else {
      grid[grid.length - 1].push(t);
      rowW = proposedW;
    }
  }

  // Position each test (x,y), with each grid row's height = max test height.
  let cursorY = MARGIN;
  let widestRowW = 0;
  for (const row of grid) {
    let cursorX = MARGIN;
    let rowMaxH = 0;
    for (const t of row) {
      t.x = cursorX;
      t.y = cursorY;
      cursorX += t.w + TEST_GAP;
      if (t.h > rowMaxH) rowMaxH = t.h;
    }
    const rowEnd = cursorX - TEST_GAP;
    if (rowEnd > widestRowW) widestRowW = rowEnd;
    cursorY += rowMaxH + TEST_GAP;
  }
  cursorY -= TEST_GAP;

  const totalW = widestRowW + MARGIN;
  const totalH = cursorY + MARGIN;

  // Compute internal positions for each test now that x,y are set.
  for (const t of tests) {
    const titleY = t.y + TEST_PAD;
    const givenY = titleY + TEST_TITLE_H;
    const whenY  = givenY + t.rowH;
    const thenY  = whenY  + t.rowH;
    const cellX  = t.x + TEST_PAD + ROW_LABEL_W;

    t.titleY = titleY;
    t.labels = {
      x: t.x + TEST_PAD,
      given: givenY + t.rowH / 2,
      when:  whenY  + t.rowH / 2,
      then:  thenY  + t.rowH / 2,
    };
    t.rows = {
      given: positionItems(t.given, cellX, t.cellW, givenY + ROW_PAD, t.itemW, ITEM_H, ITEM_GAP),
      when:  positionItems(t.when,  cellX, t.cellW, whenY  + ROW_PAD, t.itemW, ITEM_H, ITEM_GAP),
      then:  positionItems(t.then,  cellX, t.cellW, thenY  + ROW_PAD, t.itemW, ITEM_H, ITEM_GAP),
    };
  }

  return { tests, totalW, totalH };
}

function positionItems(items, colX, colW, y, itemW, itemH, gap) {
  if (items.length === 0) return [];
  const stacked = items.length * itemW + (items.length - 1) * gap;
  const startX = colX + (colW - stacked) / 2;
  return items.map((item, i) => ({
    ...item,
    x: startX + i * (itemW + gap),
    y,
    w: itemW,
    h: itemH,
  }));
}

const ITEM_STYLES = {
  domainEvent:   { fill: "#fb923c", stroke: "#7c2d12", rx: 4 },
  externalEvent: { fill: "#fbf3a8", stroke: "#854d0e", rx: 4 },
  command:       { fill: "#60a5fa", stroke: "#1e3a8a", rx: 4 },
  readModel:     { fill: "#86efac", stroke: "#14532d", rx: 14 },
  automation:    { fill: "#ffffff", stroke: "#475569", rx: 4, dash: "4 2" },
  ui:            { fill: "#ffffff", stroke: "#475569", rx: 4 },
};

export function renderSliceTests(src, target) {
  const model = parseSliceTests(src);
  const node = typeof target === "string" ? document.querySelector(target) : target;
  const targetWidth = (node && (node.clientWidth || node.getBoundingClientRect().width)) || 1200;
  const layout = layoutSliceTests(model, { targetWidth });

  const root = d3.select(node);
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

export function drawInto(svg, model, L) {
  svg.selectAll("*").remove();
  const gTests = svg.append("g").attr("class", "tests");

  for (const t of L.tests) {
    const gTest = gTests.append("g").attr("class", "test");

    // Card boundary so each test reads as its own container.
    gTest
      .append("rect")
      .attr("class", "test-card")
      .attr("x", t.x)
      .attr("y", t.y)
      .attr("width", t.w)
      .attr("height", t.h)
      .attr("rx", 8)
      .attr("ry", 8)
      .attr("fill", "#ffffff")
      .attr("stroke", "#e5e7eb")
      .attr("stroke-width", 1);

    // Test title (centered above the row labels and item cells).
    gTest
      .append("text")
      .attr("x", t.x + t.w / 2)
      .attr("y", t.titleY + 22)
      .attr("text-anchor", "middle")
      .attr("font-size", 16)
      .attr("font-weight", 600)
      .attr("fill", "#0f172a")
      .text(t.title);

    // Row labels: each test owns its Given / When / Then labels.
    const rowLabels = [
      { text: "Given", y: t.labels.given },
      { text: "When",  y: t.labels.when },
      { text: "Then",  y: t.labels.then },
    ];
    gTest
      .selectAll("text.row-label")
      .data(rowLabels)
      .join("text")
        .attr("class", "row-label")
        .attr("x", t.labels.x)
        .attr("y", (d) => d.y)
        .attr("dominant-baseline", "middle")
        .attr("font-size", 14)
        .attr("font-weight", 500)
        .attr("fill", "#374151")
        .text((d) => d.text);

    // Items in each row.
    for (const sectionKey of ["given", "when", "then"]) {
      for (const item of t.rows[sectionKey]) {
        drawItem(gTest, item);
      }
    }
  }
}

function drawItem(g, item) {
  const style = ITEM_STYLES[item.kind] || ITEM_STYLES.domainEvent;
  const node = g.append("g").attr("class", `item item-${item.kind}`);
  node
    .append("rect")
    .attr("x", item.x)
    .attr("y", item.y)
    .attr("width", item.w)
    .attr("height", item.h)
    .attr("rx", style.rx)
    .attr("ry", style.rx)
    .attr("fill", style.fill)
    .attr("stroke", style.stroke)
    .attr("stroke-width", 1.5)
    .attr("stroke-dasharray", style.dash || null);

  const lines = wrapLabel(item.label, 14);
  const lineH = 14;
  const startY = item.y + item.h / 2 - ((lines.length - 1) * lineH) / 2;
  const text = node
    .append("text")
    .attr("text-anchor", "middle")
    .attr("fill", "#0f172a")
    .attr("font-size", 12);
  text
    .selectAll("tspan")
    .data(lines)
    .join("tspan")
      .attr("x", item.x + item.w / 2)
      .attr("y", (_, i) => startY + i * lineH)
      .attr("dominant-baseline", "middle")
      .text((d) => d);
}

function wrapLabel(text, maxChars) {
  const words = (text || "").split(/\s+/);
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

export { parseSliceTests, layoutSliceTests };
