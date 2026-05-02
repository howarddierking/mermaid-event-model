// Mermaid external-diagram adapter for the Event Model DSL.
//
// Usage:
//   import mermaid from '.../mermaid.esm.min.mjs';
//   import eventModelDefinition from './event-model-mermaid.js';
//   await mermaid.registerExternalDiagrams([eventModelDefinition]);
//   mermaid.initialize({ startOnLoad: true });
//
// Then any fenced block whose first non-whitespace line is `eventModel`
// will be routed to this renderer.

import * as d3 from "d3";
import { parseEventModel, layoutEventModel, drawInto } from "./event-model.js";

// One db instance per registration. Mermaid calls parser.parse() before
// renderer.draw() for the same diagram, so we can stash the parsed model here
// and pick it up in draw() without re-parsing.
const db = {
  _model: null,
  clear() { this._model = null; },
  setModel(m) { this._model = m; },
  getModel() { return this._model; },
};

const parser = {
  // Mermaid probes `.parser.yy` on some versions; provide a dummy.
  parser: { yy: db },
  parse(text) {
    db.clear();
    db.setModel(parseEventModel(text));
    return this;
  },
};

const renderer = {
  // Mermaid creates an <svg id={id}> in the DOM, then calls draw(). Our job
  // is to populate that element. We do NOT append a new <svg>; we grab the
  // existing one by id and hand it to the shared `drawInto` routine.
  draw(_text, id /*, version, diagObj */) {
    const model = db.getModel();
    if (!model) return;
    const layout = layoutEventModel(model);

    const svg = d3.select(`#${cssEscape(id)}`);
    if (svg.empty()) return;

    svg
      .attr("width", layout.totalW)
      .attr("height", layout.totalH)
      .attr("viewBox", `0 0 ${layout.totalW} ${layout.totalH}`)
      .attr("font-family", "system-ui, -apple-system, sans-serif")
      .attr("font-size", 12)
      // Mermaid sets max-width on its container; override so wide models
      // scroll horizontally instead of shrinking to fit.
      .style("max-width", "none");

    drawInto(svg, model, layout);
  },
};

// CSS-scoped styles returned to mermaid. Mermaid injects them into a <style>
// block scoped to the diagram. These complement (not replace) the inline
// fill/stroke attributes the drawer emits.
const styles = () => `
  .em-diagram .node rect { stroke-width: 1.5; }
  .em-diagram .edge { stroke-width: 1.25; }
`;

// Mermaid's detector is called on the raw diagram source. Match either raw
// DSL (first non-empty line is `eventModel`) or a markdown wrapper containing
// the DSL inside a fenced block whose first content line is `eventModel`.
function detector(text) {
  const firstLine = (text || "").trim().split(/\r?\n/)[0] || "";
  if (/^eventModel\b/.test(firstLine)) return true;
  return /```(?:[\w-]+)?\s*\n\s*eventModel\b/.test(text || "");
}

function cssEscape(id) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(id);
  return String(id).replace(/([^\w-])/g, "\\$1");
}

const eventModelDefinition = {
  id: "eventmodel",
  detector,
  loader: async () => ({
    id: "eventmodel",
    diagram: {
      db,
      parser,
      renderer,
      styles,
      init: () => {},
    },
  }),
};

export default eventModelDefinition;
