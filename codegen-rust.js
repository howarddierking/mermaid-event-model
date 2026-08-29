// Rust AWS-native generator — a third binding of the SAME slice blueprint,
// alongside Axon (Java) and AWS-native (TypeScript). Emits a self-contained
// Lambda `main.rs` for one command slice:
//
//   - serde structs for the command and each emitted event
//   - an Event enum + exhaustive `apply_event` fold over the boundary events
//     (the compiler enforces that every read event is handled)
//   - the DCB boundary read (per-axis GSI query) + a transactional append with
//     a strongly-consistent TAGPOS guard, mirroring the TypeScript runtime
//   - a `lambda_runtime` handler over API Gateway proxy events
//
// The Rust binding is generated from the manifest core's `blueprint`, so it is
// driven by the same stack-independent artifact as the other targets. Event
// stored-names are pinned identically ("hotel.Registered"), so a Rust rebind
// reads the store the TypeScript binding wrote — the migration contract.

// DSL primitive → Rust type. Over-the-wire representation matches the TS stack
// (numbers as f64/i64, dates/uuids as String), so the DynamoDB items are
// byte-compatible with what the TypeScript binding reads/writes.
const PRIMITIVE_RUST = {
  string: "String",
  int: "i64",
  integer: "i64",
  long: "i64",
  decimal: "f64",
  float: "f64",
  double: "f64",
  number: "f64",
  boolean: "bool",
  bool: "bool",
  date: "String",
  timestamp: "String",
  datetime: "String",
  uuid: "String",
};

function rustType(dslType) {
  if (!dslType) return "serde_json::Value";
  const lower = String(dslType).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PRIMITIVE_RUST, lower)) return PRIMITIVE_RUST[lower];
  return "serde_json::Value"; // unknown domain types cross the wire as JSON
}

// snake_case an identifier (Rust field convention).
function snake(s) {
  return String(s || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "field";
}
// PascalCase (Rust type convention).
function pascal(s) {
  return String(s || "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("") || "Unnamed";
}
// SCREAMING_SNAKE.
function constant(s) {
  return snake(s).toUpperCase();
}

// Build the set of read events (fold inputs) for the command, from the core's
// boundary branches, resolved to their full element (for fields/axes).
function readEventElements(core) {
  const elById = new Map(core.blueprint.elements.map((e) => [e.id, e]));
  const ids = new Set();
  for (const b of (core.boundary && core.boundary.branches) || []) {
    for (const ev of b.events || []) ids.add(ev.id);
  }
  return [...ids].map((id) => elById.get(id)).filter(Boolean);
}

// The event this command emits (first emitted), resolved to its element.
function emittedEventElement(core) {
  const elById = new Map(core.blueprint.elements.map((e) => [e.id, e]));
  const first = (core.emits || [])[0];
  if (!first) return null;
  // core.emits carries name/storedAs; find the element by matching pascal(id).
  for (const el of core.blueprint.elements) {
    if (el.kind === "domainEvent" || el.kind === "externalEvent") {
      if (pascal(el.id) === first.name) return el;
    }
  }
  return null;
}

// A serde struct for a set of typed fields.
function rustStruct(name, fields) {
  const lines = [];
  lines.push(`#[derive(Debug, Clone, Serialize, Deserialize)]`);
  lines.push(`pub struct ${name} {`);
  for (const f of fields || []) {
    const rn = snake(f.name);
    const renamed = rn !== f.name ? `    #[serde(rename = "${f.name}")]\n` : "";
    lines.push(`${renamed}    pub ${rn}: ${rustType(f.type)},`);
  }
  lines.push(`}`);
  return lines.join("\n");
}

// The shared runtime as a Rust module string. Fixed (slice-independent): the
// DomainEvent envelope, create_event, the DCB boundary read (per-axis GSI
// query + strongly-consistent TAGPOS guard), and the transactional append.
function rustSharedRuntime() {
  return `// ── Shared event-store runtime (DCB over DynamoDB) ──────────────────────────
// Mirrors the TypeScript binding's shared/event-store.ts: same envelope, same
// tag_<axis> GSI scheme, same TAGPOS guard, so both bindings share one store.
pub mod event_store {
    use aws_sdk_dynamodb::types::{AttributeValue, Put, TransactWriteItem, Update};
    use aws_sdk_dynamodb::Client;
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct DomainEvent {
        #[serde(rename = "eventId")]
        pub event_id: String,
        pub seq: String,
        #[serde(rename = "eventType")]
        pub event_type: String,
        pub timestamp: String,
        pub tags: HashMap<String, String>,
        pub payload: serde_json::Value,
    }

    // One branch of a command's boundary: match these event types among events
    // carrying tag <axis> = <value>.
    #[derive(Debug, Clone)]
    pub struct BoundaryBranch {
        pub axis: String,
        pub value: String,
        pub types: Vec<String>,
    }

    #[derive(Debug, Clone)]
    pub struct Guard {
        pub key: String,
        pub last_seq: Option<String>,
    }

    pub struct BoundaryRead {
        pub events: Vec<DomainEvent>,
        pub guards: Vec<Guard>,
    }

    #[derive(Debug)]
    pub enum StoreError {
        Concurrency,
        Aws(String),
    }
    impl std::fmt::Display for StoreError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                StoreError::Concurrency => write!(f, "DCB boundary changed; retry"),
                StoreError::Aws(m) => write!(f, "aws error: {m}"),
            }
        }
    }
    impl std::error::Error for StoreError {}

    fn table_name() -> String {
        std::env::var("EVENT_TABLE_NAME").unwrap_or_else(|_| "HotelEvents".to_string())
    }
    fn tag_pos_key(axis: &str, value: &str) -> String {
        format!("TAGPOS#{axis}#{value}")
    }

    // Factory for a stored event. A fresh ULID gives a globally-monotonic seq.
    pub fn create_event(
        event_type: &str,
        tags: HashMap<String, String>,
        payload: serde_json::Value,
    ) -> DomainEvent {
        DomainEvent {
            event_id: ulid::Ulid::new().to_string(),
            seq: ulid::Ulid::new().to_string(),
            event_type: event_type.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            tags,
            payload,
        }
    }

    fn attr_s(v: &AttributeValue) -> Option<String> {
        v.as_s().ok().cloned()
    }

    // Deserialize a stored item (map of AttributeValue) into a DomainEvent.
    fn item_to_event(item: &HashMap<String, AttributeValue>) -> Option<DomainEvent> {
        let event_id = item.get("eventId").and_then(attr_s)?;
        let seq = item.get("seq").and_then(attr_s)?;
        let event_type = item.get("eventType").and_then(attr_s)?;
        let timestamp = item.get("timestamp").and_then(attr_s).unwrap_or_default();
        let mut tags = HashMap::new();
        if let Some(AttributeValue::M(m)) = item.get("tags") {
            for (k, v) in m {
                if let Some(s) = attr_s(v) {
                    tags.insert(k.clone(), s);
                }
            }
        }
        let payload = match item.get("payload") {
            Some(AttributeValue::S(s)) => {
                serde_json::from_str(s).unwrap_or(serde_json::Value::Null)
            }
            _ => serde_json::Value::Null,
        };
        Some(DomainEvent { event_id, seq, event_type, timestamp, tags, payload })
    }

    // Query one branch: events carrying tag <axis>=<value>, filtered to the
    // branch's event types. Reads the per-axis GSI (eventually consistent;
    // seeds the fold only — enforcement is the guard on append).
    async fn query_branch(
        client: &Client,
        branch: &BoundaryBranch,
    ) -> Result<Vec<DomainEvent>, StoreError> {
        let res = client
            .query()
            .table_name(table_name())
            .index_name(format!("gsi_{}", branch.axis))
            .key_condition_expression(format!("tag_{} = :v", branch.axis))
            .expression_attribute_values(":v", AttributeValue::S(branch.value.clone()))
            .scan_index_forward(true)
            .send()
            .await
            .map_err(|e| StoreError::Aws(format!("query: {:?}", aws_sdk_dynamodb::error::DisplayErrorContext(&e))))?;
        let mut out = Vec::new();
        for item in res.items() {
            if let Some(ev) = item_to_event(item) {
                if branch.types.iter().any(|t| t == &ev.event_type) {
                    out.push(ev);
                }
            }
        }
        Ok(out)
    }

    // Read the whole boundary: deduped fold events (ordered by seq) + one
    // strongly-consistent TAGPOS guard per distinct (axis,value).
    pub async fn read_boundary(
        client: &Client,
        criteria: &[BoundaryBranch],
    ) -> Result<BoundaryRead, StoreError> {
        let mut by_id: HashMap<String, DomainEvent> = HashMap::new();
        for branch in criteria {
            for e in query_branch(client, branch).await? {
                by_id.insert(e.event_id.clone(), e);
            }
        }
        let mut events: Vec<DomainEvent> = by_id.into_values().collect();
        events.sort_by(|a, b| a.seq.cmp(&b.seq));

        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut guards = Vec::new();
        for branch in criteria {
            let key = tag_pos_key(&branch.axis, &branch.value);
            if !seen.insert(key.clone()) {
                continue;
            }
            let res = client
                .get_item()
                .table_name(table_name())
                .key("eventId", AttributeValue::S(key.clone()))
                .key("seq", AttributeValue::S("POS".to_string()))
                .consistent_read(true)
                .send()
                .await
                .map_err(|e| StoreError::Aws(format!("getitem: {:?}", aws_sdk_dynamodb::error::DisplayErrorContext(&e))))?;
            let last_seq = res
                .item()
                .and_then(|i| i.get("lastSeq"))
                .and_then(attr_s);
            guards.push(Guard { key, last_seq });
        }
        Ok(BoundaryRead { events, guards })
    }

    // Append an event within its boundary, atomically: assert each TAGPOS guard
    // is unchanged, Put the event (with tag_<axis> attributes so the GSIs index
    // it; empty values skipped), and advance each guard to this event's seq.
    pub async fn append_within_boundary(
        client: &Client,
        event: &DomainEvent,
        guards: &[Guard],
    ) -> Result<(), StoreError> {
        let mut item: HashMap<String, AttributeValue> = HashMap::new();
        item.insert("eventId".into(), AttributeValue::S(event.event_id.clone()));
        item.insert("seq".into(), AttributeValue::S(event.seq.clone()));
        item.insert("eventType".into(), AttributeValue::S(event.event_type.clone()));
        item.insert("timestamp".into(), AttributeValue::S(event.timestamp.clone()));
        let tag_map: HashMap<String, AttributeValue> = event
            .tags
            .iter()
            .map(|(k, v)| (k.clone(), AttributeValue::S(v.clone())))
            .collect();
        item.insert("tags".into(), AttributeValue::M(tag_map));
        item.insert(
            "payload".into(),
            AttributeValue::S(serde_json::to_string(&event.payload).unwrap_or_else(|_| "null".into())),
        );
        // tag_<axis> attributes for the GSIs — skip empty values.
        for (axis, value) in &event.tags {
            if !value.is_empty() {
                item.insert(format!("tag_{axis}"), AttributeValue::S(value.clone()));
            }
        }

        let put = Put::builder()
            .table_name(table_name())
            .set_item(Some(item))
            .condition_expression("attribute_not_exists(eventId)")
            .build()
            .map_err(|e| StoreError::Aws(e.to_string()))?;
        let mut tx: Vec<TransactWriteItem> = vec![TransactWriteItem::builder().put(put).build()];

        for g in guards {
            let mut update = Update::builder()
                .table_name(table_name())
                .key("eventId", AttributeValue::S(g.key.clone()))
                .key("seq", AttributeValue::S("POS".to_string()))
                .update_expression("SET lastSeq = :seq")
                .expression_attribute_values(":seq", AttributeValue::S(event.seq.clone()));
            update = match &g.last_seq {
                None => update.condition_expression("attribute_not_exists(lastSeq)"),
                Some(prev) => update
                    .condition_expression("lastSeq = :prev")
                    .expression_attribute_values(":prev", AttributeValue::S(prev.clone())),
            };
            let update = update.build().map_err(|e| StoreError::Aws(e.to_string()))?;
            tx.push(TransactWriteItem::builder().update(update).build());
        }

        let res = client.transact_write_items().set_transact_items(Some(tx)).send().await;
        match res {
            Ok(_) => Ok(()),
            Err(e) => {
                // Surface the full service error (message + source chain), not
                // just the generic Display, so failures are diagnosable.
                let detail = format!("{:?}", aws_sdk_dynamodb::error::DisplayErrorContext(&e));
                if detail.contains("ConditionalCheckFailed") || detail.contains("TransactionCanceled") {
                    Err(StoreError::Concurrency)
                } else {
                    Err(StoreError::Aws(detail))
                }
            }
        }
    }
}
`;
}

/**
 * Generate the Rust AWS-native binding (a single Lambda `main.rs`) from a
 * manifest core. Command slices only (a boundary-reading or creation command).
 * @param {object} core  a manifest core with a `blueprint` (object form)
 * @param {object} [opts]
 * @param {string} [opts.sliceName]
 * @returns {string} Rust source (main.rs)
 */
export function generateRustMainFromCore(core, opts = {}) {
  const sliceName = opts.sliceName || core.slice || "slice";
  const cmd = core.command;
  if (!cmd) {
    throw new Error(`Rust target supports command slices; slice '${sliceName}' has no command`);
  }
  const cmdName = pascal(cmd.id);
  const emitted = emittedEventElement(core);
  const readEvents = readEventElements(core);
  const branches = (core.boundary && core.boundary.branches) || [];
  const isCreation = branches.length === 0;

  // Command struct fields (typed).
  const cmdFields = cmd.fields || [];
  const cmdFieldNames = new Set(cmdFields.map((f) => f.name));

  // The emitted event's axis fields (tags) and payload fields.
  const evFields = (emitted && emitted.fields) || [];
  const evAxes = evFields.filter((f) => f.axis);
  const evPayload = evFields.filter((f) => !f.axis);

  const L = [];
  const p = (s = "") => L.push(s);

  // Header.
  p("// ─────────────────────────────────────────────────────────────");
  p(`// Generated from slice: ${sliceName}`);
  p("// Target: AWS-native Rust (lambda_runtime + aws-sdk-dynamodb, DCB)");
  p("// A third binding of the same blueprint. Event stored-names are pinned");
  p("// identically, so this reads the store the TypeScript/Java bindings wrote.");
  p("// Source of truth is the manifest core — regenerate, don't hand-edit.");
  p("// ─────────────────────────────────────────────────────────────");
  p("use aws_config::BehaviorVersion;");
  p("use aws_sdk_dynamodb::Client;");
  p("use lambda_runtime::{service_fn, Error, LambdaEvent};");
  p("use serde::{Deserialize, Serialize};");
  p("use serde_json::{json, Value};");
  p("use std::collections::HashMap;");
  p("");
  p("use event_store::{append_within_boundary, create_event, read_boundary, BoundaryBranch, StoreError};");
  p("");

  // Shared runtime module (inlined for a self-contained single-crate binary).
  p(rustSharedRuntime());
  p("");

  // Command struct.
  p(`// ── Command ─────────────────────────────────────────────────────`);
  p(rustStruct(cmdName, cmdFields));
  p("");

  // Emitted-event payload struct (for documentation / typed construction).
  if (emitted) {
    p(`// ── Emitted event: ${emitted.label || emitted.id} (stored as ${core.emits[0].storedAs}) ──`);
    p(rustStruct(pascal(emitted.id), evFields));
    p("");
  }

  // Fold state + apply_event over the boundary events (exhaustive match).
  p(`// ── Decision state — folded from the boundary events ────────────`);
  p(`#[derive(Debug, Default, Clone)]`);
  p(`struct DecisionState {`);
  p(`    event_count: u64,`);
  // Fields the fold surfaces: union of read events' fields (used for tag sourcing).
  const stateFields = new Map();
  for (const ev of readEvents) for (const f of ev.fields || []) stateFields.set(f.name, f.type);
  for (const [name, type] of stateFields) {
    p(`    ${snake(name)}: Option<${rustType(type)}>,`);
  }
  p(`}`);
  p("");
  p(`fn apply_event(mut state: DecisionState, event: &event_store::DomainEvent) -> DecisionState {`);
  p(`    match event.event_type.as_str() {`);
  for (const ev of readEvents) {
    const stored = `hotel.${pascal(ev.id)}`;
    p(`        ${JSON.stringify(stored)} => {`);
    for (const f of ev.fields || []) {
      const sn = snake(f.name);
      if (f.axis) {
        p(`            state.${sn} = event.tags.get(${JSON.stringify(f.name)}).cloned()${rustFromString(f.type)};`);
      } else {
        p(`            state.${sn} = event.payload.get(${JSON.stringify(f.name)})${rustFromJson(f.type)};`);
      }
    }
    p(`            state.event_count += 1;`);
    p(`        }`);
  }
  p(`        _ => {}`);
  p(`    }`);
  p(`    state`);
  p(`}`);
  p("");

  // The handler.
  p(`// ── Handler ─────────────────────────────────────────────────────`);
  p(`async fn handle(client: &Client, cmd: ${cmdName}) -> Result<Value, StoreError> {`);
  // Axis values needed (command axes + event axes).
  p(`    const MAX_RETRIES: u32 = 5;`);

  if (isCreation) {
    // Creation: no boundary. Build tags + payload directly from the command.
    p(`    // Creation command — no boundary to read.`);
    emitTagsAndAppend(p, { core, cmd, emitted, evAxes, evPayload, cmdFieldNames, hasState: false, indent: "    " });
  } else {
    // Boundary criteria from branches.
    p(`    let criteria = vec![`);
    for (const b of branches) {
      const axis = (b.axes || [])[0];
      if (!axis) continue; // axis-less branches unsupported (rare)
      const types = (b.events || []).map((e) => JSON.stringify(e.storedAs)).join(", ");
      const axisSrc = cmdFieldNames.has(axis) ? `cmd.${snake(axis)}.clone()` : `String::new()`;
      p(`        BoundaryBranch { axis: ${JSON.stringify(axis)}.into(), value: ${axisSrc}, types: vec![${types}].into_iter().map(String::from).collect() },`);
    }
    p(`    ];`);
    p(`    for _ in 0..MAX_RETRIES {`);
    p(`        let boundary = read_boundary(client, &criteria).await?;`);
    p(`        let mut state = DecisionState::default();`);
    p(`        for e in &boundary.events { state = apply_event(state, e); }`);
    p(`        let _ = &state; // available for validation / tag sourcing`);
    emitTagsAndAppend(p, { core, cmd, emitted, evAxes, evPayload, cmdFieldNames, hasState: true, indent: "        " });
    p(`    }`);
    p(`    Err(StoreError::Concurrency)`);
  }
  p(`}`);
  p("");

  // main + lambda wiring.
  p(`#[derive(Deserialize)]`);
  p(`struct ApiEvent { body: Option<String> }`);
  p("");
  p(`#[tokio::main]`);
  p(`async fn main() -> Result<(), Error> {`);
  p(`    let config = aws_config::load_defaults(BehaviorVersion::latest()).await;`);
  p(`    let client = Client::new(&config);`);
  p(`    lambda_runtime::run(service_fn(|ev: LambdaEvent<ApiEvent>| {`);
  p(`        let client = client.clone();`);
  p(`        async move {`);
  p(`            let body = ev.payload.body.unwrap_or_default();`);
  p(`            let cmd: ${cmdName} = serde_json::from_str(&body)`);
  p(`                .map_err(|e| Error::from(format!("bad request: {e}")))?;`);
  p(`            match handle(&client, cmd).await {`);
  p(`                Ok(v) => Ok::<Value, Error>(json!({ "statusCode": 200, "body": v.to_string() })),`);
  p(`                Err(StoreError::Concurrency) => Ok(json!({ "statusCode": 409, "body": "{\\"error\\":\\"conflict\\"}" })),`);
  p(`                Err(e) => Ok(json!({ "statusCode": 500, "body": format!("{{\\"error\\":\\"{e}\\"}}") })),`);
  p(`            }`);
  p(`        }`);
  p(`    }))`);
  p(`    .await`);
  p(`}`);

  return L.join("\n") + "\n";
}

// Emit the tags map, payload, event creation, append + response — shared by the
// creation and boundary paths.
function emitTagsAndAppend(p, { core, cmd, emitted, evAxes, evPayload, cmdFieldNames, hasState, indent }) {
  const i = indent;
  const storedType = core.emits && core.emits[0] ? core.emits[0].storedAs : "unknown";
  // tags: one per emitted-event axis field.
  p(`${i}let mut tags: HashMap<String, String> = HashMap::new();`);
  for (const f of evAxes) {
    const sn = snake(f.name);
    if (cmdFieldNames.has(f.name)) {
      p(`${i}if !cmd.${sn}.to_string().is_empty() { tags.insert(${JSON.stringify(f.name)}.into(), ${rustToString("cmd." + sn, f.type)}); }`);
    } else if (hasState) {
      // Not on the command — source from the folded boundary state.
      p(`${i}if let Some(v) = &state.${sn} { tags.insert(${JSON.stringify(f.name)}.into(), ${rustToString("v", f.type, true)}); }`);
    } else {
      p(`${i}// axis '${f.name}' not supplied by the command and no boundary state`);
    }
  }
  // payload: emitted-event non-axis fields, sourced from the command when present.
  p(`${i}let mut payload = serde_json::Map::new();`);
  for (const f of evPayload) {
    const sn = snake(f.name);
    if (cmdFieldNames.has(f.name)) {
      p(`${i}payload.insert(${JSON.stringify(f.name)}.into(), json!(cmd.${sn}));`);
    } else if (hasState) {
      p(`${i}if let Some(v) = &state.${sn} { payload.insert(${JSON.stringify(f.name)}.into(), json!(v)); }`);
    }
    // else: unmapped field (e.g. a timestamp/derived value) — left unset by design.
  }
  p(`${i}let event = create_event(${JSON.stringify(storedType)}, tags, Value::Object(payload));`);
  if (hasState) {
    p(`${i}match append_within_boundary(client, &event, &boundary.guards).await {`);
    p(`${i}    Ok(()) => return Ok(json!({ "eventId": event.event_id })),`);
    p(`${i}    Err(StoreError::Concurrency) => continue,`);
    p(`${i}    Err(e) => return Err(e),`);
    p(`${i}}`);
  } else {
    p(`${i}append_within_boundary(client, &event, &[]).await?;`);
    p(`${i}return Ok(json!({ "eventId": event.event_id }));`);
  }
}

// Convert a value expression to String for a tag (tags are always strings).
function rustToString(expr, type, isRef = false) {
  const t = rustType(type);
  if (t === "String") return isRef ? `${expr}.clone()` : `${expr}.clone()`;
  return `${expr}.to_string()`;
}
// Parse a stored tag string back to the field's type when folding into state.
function rustFromString(type) {
  const t = rustType(type);
  if (t === "String") return "";
  // numeric/bool tag stored as string → parse, dropping on failure.
  return `.and_then(|s| s.parse::<${t}>().ok()).map(|v| v)`;
}
// Pull a payload JSON value into an Option<T> for state.
function rustFromJson(type) {
  const t = rustType(type);
  if (t === "String") return ".and_then(|v| v.as_str().map(String::from))";
  if (t === "i64") return ".and_then(|v| v.as_i64())";
  if (t === "f64") return ".and_then(|v| v.as_f64())";
  if (t === "bool") return ".and_then(|v| v.as_bool())";
  return ".cloned().map(Some).unwrap_or(None)";
}
