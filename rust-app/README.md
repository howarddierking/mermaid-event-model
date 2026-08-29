# rust-app — AWS-native Rust binding (register slice)

A third binding of the event model, alongside `aws-app` (TypeScript) and the
Axon (Java) target: the generated **Rust** Lambda for the `register` slice.
It reads and writes the **same** DynamoDB event store the TypeScript binding
uses (`HotelEvents`), under the same pinned event name (`hotel.Registered`) —
the reentrant-blueprint migration contract, proven with a genuinely different
language/runtime.

## Layout

```
emit.mjs            regenerates src/main.rs via ../codegen.js --target rust
src/main.rs         GENERATED: self-contained Lambda (event_store module +
                    command/event structs + apply_event fold + DCB append +
                    lambda_runtime handler)
Cargo.toml          crate (bin name must be `bootstrap`)
cdk/app.ts          CDK stack: the Rust Lambda + IAM grant on HotelEvents + GSIs
```

## Prerequisites

- Rust toolchain (`rustup`/`cargo`)
- [`cargo-lambda`](https://www.cargo-lambda.info/) and `zig` (cross-linker):
  `brew install zig cargo-lambda/tap/cargo-lambda`
- The `HotelEvents` table must already exist (deploy `aws-app`'s
  `HotelEventStore` stack first).

## Generate → build → deploy

```sh
# 1. (re)generate the Rust handler from the register slice spec
node emit.mjs

# 2. cross-compile to a provided.al2023 arm64 bootstrap binary
cargo lambda build --release --arm64
#    → target/lambda/bootstrap/bootstrap

# 3. deploy the Lambda (references the existing HotelEvents table)
cd cdk && npm install && npx cdk deploy HotelRustRegister --require-approval never
```

### ts-node note

Some `ts-node` + TypeScript/Node combinations fail to load `app.ts`
(`Cannot read properties of undefined (reading 'fileExists')`). If `cdk deploy`
errors there, compile to JS and point CDK at it:

```sh
cd cdk
npx tsc app.ts --module commonjs --target ES2022 --esModuleInterop --skipLibCheck --types node
# then set cdk.json "app" to "node app.js" and deploy
```

## Smoke test

```sh
FN=hotel-register-rust
aws lambda invoke --function-name "$FN" --region us-east-1 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"body":"{\"name\":\"Rusty\",\"email\":\"rusty@example.com\",\"password\":\"x\"}"}' \
  /tmp/out.json && cat /tmp/out.json
# → {"body":"{\"eventId\":\"...\"}","statusCode":200}

# confirm the event landed in the SHARED store, via the email GSI
aws dynamodb query --table-name HotelEvents --region us-east-1 --index-name gsi_email \
  --key-condition-expression "tag_email = :e" \
  --expression-attribute-values '{":e":{"S":"rusty@example.com"}}' \
  --query "Items[].eventType.S"
# → [ "hotel.Registered" ]
```

## Why the explicit IAM statement

The DCB boundary query reads per-axis GSIs (`gsi_<axis>`). CDK's
`table.grantReadWriteData(fn)` on a `Table.fromTableName` reference grants the
table ARN but **not** `table/<name>/index/*`, so the query is denied with
`AccessDeniedException`. `cdk/app.ts` therefore grants the DynamoDB actions on
both the table and its indexes.

## Notes

- The Rust Lambda is cheap (no always-on cost); it bills per invocation.
- Tear down with `cd cdk && npx cdk destroy HotelRustRegister`.
