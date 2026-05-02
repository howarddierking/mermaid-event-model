// Combined Mermaid external-diagram registration entry point.
//
// Default export is an array of every diagram definition this package ships,
// ready to pass directly to `mermaid.registerExternalDiagrams()`. Individual
// definitions are also re-exported by name for one-at-a-time registration.
//
//   import diagrams from "@howarddierking/mermaid-event-model";
//   await mermaid.registerExternalDiagrams(diagrams);
//
//   // or:
//   import { eventModelDefinition, sliceTestsDefinition }
//     from "@howarddierking/mermaid-event-model";
//   await mermaid.registerExternalDiagrams([eventModelDefinition]);

import eventModelDefinition from "./event-model-mermaid.js";
import sliceTestsDefinition from "./slice-tests-mermaid.js";

export { eventModelDefinition, sliceTestsDefinition };
export default [eventModelDefinition, sliceTestsDefinition];
