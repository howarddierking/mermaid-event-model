# Framework references

Sources consulted on 2026-05-20 while building this reference app. Pinned
versions are in the parent `pom.xml`, `docker-compose.yml`, and
`application.properties`.

## Ground truth

- `AxonIQ/university-demo` (local clone at
  `/Users/howarddierking/dev/github.com/AxonIQ/university-demo`) — the
  authoritative example of Axon 5 DCB programming. The slice anatomy in
  `axon5-dcb-anatomy.md` is distilled from this repo.

## Axon

- Axon Framework 5 — https://docs.axoniq.io/axon-framework-reference/5.0/
- DCB in AF 5 (blog) — https://www.axoniq.io/blog/dcb-in-af-5
- Axon Server Docker — https://docs.axoniq.io/axon-server-installation/professional/docker-compose/
- Maven Central `org.axonframework:axon-framework-bom:5.0.0`

## Quarkus

- Quarkus 3.31 release notes — https://quarkus.io/blog/quarkus-3-31-released/
- Quarkus OpenTelemetry guide — https://quarkus.io/guides/opentelemetry
- Quarkus OpenTelemetry Logging — https://quarkus.io/guides/opentelemetry-logging

## .NET Aspire dashboard (standalone)

- Standalone dashboard — https://aspire.dev/dashboard/standalone/
- Configuration — https://aspire.dev/dashboard/configuration/
- Docker image — `mcr.microsoft.com/dotnet/aspire-dashboard:latest`
- OTLP ports inside the container: gRPC 18889, HTTP 18890, UI 18888.

## Pins corrected during build verification

- **Quarkus 3.31.0 → 3.35.4**: the original research recommended 3.31, but
  Maven Central's latest GA at the time of this build was 3.35.4. 3.31 was
  never published. Bumped in the parent pom; OTel properties unchanged.
- **CORS property rename**: `quarkus.http.cors=true` is no longer recognized;
  the current property is `quarkus.http.cors.enabled=true`. Origins config
  (`quarkus.http.cors.origins=...`) is unchanged.

## Open items to revisit

- **Telemetry granularity** — the Quarkus OTel extension does not auto-trace
  Axon's command bus internals. Once the slice runs end-to-end, add manual
  spans around the command handler so a request trace stays readable. See
  also the `OpenTelemetry` API in `opentelemetry-api`.
