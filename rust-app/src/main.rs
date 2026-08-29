// ─────────────────────────────────────────────────────────────
// Generated from slice: register
// Target: AWS-native Rust (lambda_runtime + aws-sdk-dynamodb, DCB)
// A third binding of the same blueprint. Event stored-names are pinned
// identically, so this reads the store the TypeScript/Java bindings wrote.
// Source of truth is the manifest core — regenerate, don't hand-edit.
// ─────────────────────────────────────────────────────────────
use aws_config::BehaviorVersion;
use aws_sdk_dynamodb::Client;
use lambda_runtime::{service_fn, Error, LambdaEvent};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

use event_store::{append_within_boundary, create_event, read_boundary, BoundaryBranch, StoreError};

// ── Shared event-store runtime (DCB over DynamoDB) ──────────────────────────
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


// ── Command ─────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Register {
    pub name: String,
    pub email: String,
    pub password: String,
}

// ── Emitted event: Registered (stored as hotel.Registered) ──
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registered {
    pub email: String,
    pub name: String,
    #[serde(rename = "registeredAt")]
    pub registered_at: String,
}

// ── Decision state — folded from the boundary events ────────────
#[derive(Debug, Default, Clone)]
struct DecisionState {
    event_count: u64,
    email: Option<String>,
    name: Option<String>,
    registered_at: Option<String>,
}

fn apply_event(mut state: DecisionState, event: &event_store::DomainEvent) -> DecisionState {
    match event.event_type.as_str() {
        "hotel.Registered" => {
            state.email = event.tags.get("email").cloned();
            state.name = event.payload.get("name").and_then(|v| v.as_str().map(String::from));
            state.registered_at = event.payload.get("registeredAt").and_then(|v| v.as_str().map(String::from));
            state.event_count += 1;
        }
        _ => {}
    }
    state
}

// ── Handler ─────────────────────────────────────────────────────
async fn handle(client: &Client, cmd: Register) -> Result<Value, StoreError> {
    const MAX_RETRIES: u32 = 5;
    let criteria = vec![
        BoundaryBranch { axis: "email".into(), value: cmd.email.clone(), types: vec!["hotel.Registered"].into_iter().map(String::from).collect() },
    ];
    for _ in 0..MAX_RETRIES {
        let boundary = read_boundary(client, &criteria).await?;
        let mut state = DecisionState::default();
        for e in &boundary.events { state = apply_event(state, e); }
        let _ = &state; // available for validation / tag sourcing
        let mut tags: HashMap<String, String> = HashMap::new();
        if !cmd.email.to_string().is_empty() { tags.insert("email".into(), cmd.email.clone()); }
        let mut payload = serde_json::Map::new();
        payload.insert("name".into(), json!(cmd.name));
        if let Some(v) = &state.registered_at { payload.insert("registeredAt".into(), json!(v)); }
        let event = create_event("hotel.Registered", tags, Value::Object(payload));
        match append_within_boundary(client, &event, &boundary.guards).await {
            Ok(()) => return Ok(json!({ "eventId": event.event_id })),
            Err(StoreError::Concurrency) => continue,
            Err(e) => return Err(e),
        }
    }
    Err(StoreError::Concurrency)
}

#[derive(Deserialize)]
struct ApiEvent { body: Option<String> }

#[tokio::main]
async fn main() -> Result<(), Error> {
    let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let client = Client::new(&config);
    lambda_runtime::run(service_fn(|ev: LambdaEvent<ApiEvent>| {
        let client = client.clone();
        async move {
            let body = ev.payload.body.unwrap_or_default();
            let cmd: Register = serde_json::from_str(&body)
                .map_err(|e| Error::from(format!("bad request: {e}")))?;
            match handle(&client, cmd).await {
                Ok(v) => Ok::<Value, Error>(json!({ "statusCode": 200, "body": v.to_string() })),
                Err(StoreError::Concurrency) => Ok(json!({ "statusCode": 409, "body": "{\"error\":\"conflict\"}" })),
                Err(e) => Ok(json!({ "statusCode": 500, "body": format!("{{\"error\":\"{e}\"}}") })),
            }
        }
    }))
    .await
}
