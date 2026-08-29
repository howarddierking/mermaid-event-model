#!/usr/bin/env node
// gen.js — generate a binding (code) from a slice-spec .md, per the reentrant
// blueprint's forward step:  slice spec ──generate──► implementation.
//
// The slice spec .md is the generator's only input. Both parsers extract their
// own fenced blocks from it, so pass the whole file.
//
// Usage:
//   node bin/gen.js <slice.md> --target aws|axon|rust [options]
//
// Options:
//   --target, -t   aws | axon | rust                 (required)
//   --via-core     route through the manifest core (spec → core → code);
//                  proves the core is a sufficient, stack-independent blueprint
//   --part         aws only: slice | runtime | infra   (default: slice)
//   --tier         aws infra only: production | minimal (default: production)
//   --slice        slice name for headers/filenames (default: from the file)
//   -o, --out      write to this file instead of stdout
//   -h, --help     show this help
//
// Examples:
//   node bin/gen.js blueprint_dsl_dcb-slices/check-in.md -t aws
//   node bin/gen.js check-in.md -t axon -o CheckIn.java
//   node bin/gen.js check-in.md -t aws --via-core -o handler.ts
//   node bin/gen.js blueprint_dsl_dcb.md -t aws --part infra --tier minimal

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const codegenUrl = new URL("../codegen.js", import.meta.url);

function usage(msg) {
  if (msg) process.stderr.write(`gen.js: ${msg}\n\n`);
  process.stderr.write(
    "Usage: node bin/gen.js <slice.md> --target aws|axon|rust [--via-core] " +
    "[--part slice|runtime|infra] [--tier production|minimal] [--slice <name>] [-o <file>]\n"
  );
  process.exit(msg ? 1 : 0);
}

// ── Parse args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = { target: null, viaCore: false, part: "slice", tier: "production", slice: null, out: null };
let input = null;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  switch (a) {
    case "-h": case "--help": usage(); break;
    case "-t": case "--target": opts.target = next(); break;
    case "--via-core": opts.viaCore = true; break;
    case "--part": opts.part = next(); break;
    case "--tier": opts.tier = next(); break;
    case "--slice": opts.slice = next(); break;
    case "-o": case "--out": opts.out = next(); break;
    default:
      if (a.startsWith("-")) usage(`unknown option: ${a}`);
      else if (input) usage(`unexpected extra argument: ${a}`);
      else input = a;
  }
}

if (!input) usage("no input .md file given");
if (!opts.target) usage("--target is required (aws | axon | rust)");
if (!["aws", "axon", "rust"].includes(opts.target)) usage(`--target must be aws, axon, or rust, got '${opts.target}'`);
if (!fs.existsSync(input)) usage(`file not found: ${input}`);

// Default the slice name from the file's `<!-- slice id: X -->` or its basename.
const src = fs.readFileSync(input, "utf8");
const sliceName =
  opts.slice ||
  (src.match(/<!--\s*slice id:\s*([\w-]+)\s*-->/) || [])[1] ||
  path.basename(input).replace(/\.md$/, "").replace(/-/g, "_");

// ── Generate ────────────────────────────────────────────────────────────────
const cg = await import(codegenUrl.href);

let output;
try {
  if (opts.viaCore) {
    // spec → core (durable blueprint contract) → code
    const core = cg.generateManifestCoreFromSource(src, { sliceName });
    output = cg.generateFromCore(core, opts.target, {
      sliceName,
      part: opts.part,
      tier: opts.tier,
    });
  } else if (opts.target === "aws") {
    output = cg.generateAwsFromSource(src, { sliceName, part: opts.part, tier: opts.tier });
  } else if (opts.target === "rust") {
    output = cg.generateRustFromSource(src, { sliceName });
  } else {
    output = cg.generateFromSource(src, { sliceName });
  }
} catch (err) {
  process.stderr.write(`gen.js: generation failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
}

if (opts.out) {
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, output);
  process.stderr.write(`wrote ${opts.out} (${output.length} bytes, target=${opts.target}${opts.viaCore ? ", via core" : ""})\n`);
} else {
  process.stdout.write(output);
}
