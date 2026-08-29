// Emits the generated Rust Lambda for the `register` slice into this app.
// Regenerate with:  node emit.mjs
//
// It calls the mermaid-event-model Rust generator (the parent repo's
// codegen.js --target rust) on the register slice spec and writes src/main.rs.
// The Cargo.toml, CDK app, and README are hand-authored scaffolding.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(here, "..");
const SLICE = path.join(LIB, "blueprint_dsl_dcb-slices", "register.md");

const { generateRustFromSource } = await import(path.join(LIB, "codegen.js"));

const src = fs.readFileSync(SLICE, "utf8");
const rust = generateRustFromSource(src, { sliceName: "register" });

const dest = path.join(here, "src", "main.rs");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, rust);
console.log(`wrote src/main.rs (${rust.length} bytes) from ${path.relative(LIB, SLICE)}`);
