# Hotel reference application — Axon 5 / Java 25 / Quarkus

End-to-end reference for the `add_room` slice from `blueprint_dsl_dcb.md`.
Ground truth for the future code-generation skill targeting Axon 5 + Java.

Pinned versions: Axon Framework 5.0.0, Quarkus 3.35.4, Java 25,
Maven 3.9.9 (via wrapper).

## Layout

```
pom.xml                   # parent: BOMs, versions
mvnw, mvnw.cmd, .mvn/     # Maven Wrapper — no system Maven required
event-model/              # library jar — slices, configuration, EventModelModule
web-api/                  # Quarkus app — REST + Axon bootstrap
ui/                       # Vite + React, Room Management screen
infrastructure/
  docker-compose.yml      # axon-server, aspire-dashboard, postgres
framework-notes/
  axon5-dcb-anatomy.md    # slice→Java mapping (the code-gen reference)
  references.md           # sources + dates fetched + pin corrections
```

## Build

```
./mvnw -pl event-model test                  # 2/2 tests passing for the add_room slice
./mvnw -pl web-api -am package -DskipTests   # full Quarkus augmentation
```

First run downloads Maven 3.9.9 and all dependencies — give it a minute.

Unit tests use `axon-test`'s `AxonTestFixture` with Axon Server disabled,
so they do **not** require infra to be running.

## Run it end-to-end

1. Start infra:
   ```
   docker compose -f infrastructure/docker-compose.yml up -d
   ```
   - Axon Server UI: http://localhost:8024
   - Aspire dashboard: http://localhost:18888
   - Postgres: localhost:5432 (hotel / hotel / hotel)

2. Start the web API in dev mode:
   ```
   ./mvnw -pl web-api -am quarkus:dev
   ```
   Listens on http://localhost:8080. OTLP exports to localhost:4317
   (Aspire dashboard's gRPC ingress, published from container port 18889).

3. Start the UI:
   ```
   cd ui && npm install && npm run dev
   ```
   Opens at http://localhost:5173.

## Slice → code mapping

See `framework-notes/axon5-dcb-anatomy.md`. The `add_room` slice is the
canonical worked example; once a second pattern (e.g. read-model projection
for `view_room_availability`) lands, the doc will grow another section.

## What is and isn't reusable

- **Reusable (becomes the skill)**: the per-slice file structure under
  `event-model/`, the conventions in `framework-notes/axon5-dcb-anatomy.md`,
  and the contract between slices and `EventModelModule`.
- **One-time scaffolding (stays here, not in the skill)**: the parent pom,
  Quarkus bootstrap, docker-compose, OTel wiring, React UI shell. Built once
  per repo using this reference as a template.
