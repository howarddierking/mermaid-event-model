// Mermaid external-diagram adapter for the Slice Tests DSL.
//
// Usage:
//   import mermaid from '.../mermaid.esm.min.mjs';
//   import sliceTestsDefinition from './slice-tests-mermaid.js';
//   await mermaid.registerExternalDiagrams([sliceTestsDefinition]);
//   mermaid.initialize({ startOnLoad: true });
//
// Any fenced block whose first non-whitespace line is `sliceTests` will be
// routed to this renderer.

import * as d3 from "d3";
import { parseSliceTests, layoutSliceTests, drawInto } from "./slice-tests.js";

const db = {
  _model: null,
  clear() { this._model = null; },
  setModel(m) { this._model = m; },
  getModel() { return this._model; },
};

const parser = {
  parser: { yy: db },
  parse(text) {
    db.clear();
    db.setModel(parseSliceTests(text));
    return this;
  },
};

const renderer = {
  draw(_text, id /*, version, diagObj */) {
    const model = db.getModel();
    if (!model) return;

    const svg = d3.select(`#${cssEscape(id)}`);
    if (svg.empty()) return;

    // Use the container width (viewport-derived) so tests grid-pack into rows
    // that fill the available horizontal space.
    const parent = svg.node().parentElement;
    const targetWidth = (parent && parent.clientWidth) || 1200;
    const layout = layoutSliceTests(model, { targetWidth });

    svg
      .attr("width", layout.totalW)
      .attr("height", layout.totalH)
      .attr("viewBox", `0 0 ${layout.totalW} ${layout.totalH}`)
      .attr("font-family", "system-ui, -apple-system, sans-serif")
      .attr("font-size", 12)
      .style("max-width", "none");

    drawInto(svg, model, layout);
  },
};

const styles = () => `
  .st-diagram .item rect { stroke-width: 1.5; }
`;

function detector(text) {
  const firstLine = (text || "").trim().split(/\r?\n/)[0] || "";
  return /^sliceTests\b/.test(firstLine);
}

function cssEscape(id) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(id);
  return String(id).replace(/([^\w-])/g, "\\$1");
}

const sliceTestsDefinition = {
  id: "slicetests",
  detector,
  loader: async () => ({
    id: "slicetests",
    diagram: {
      db,
      parser,
      renderer,
      styles,
      init: () => {},
    },
  }),
};

export default sliceTestsDefinition;
