#!/usr/bin/env node
// Deploys ONLY the generated Rust `register` Lambda, granting it access to the
// EXISTING HotelEvents event store (created by the aws-app HotelEventStore
// stack). A Function URL gives a no-auth HTTPS endpoint for smoke tests.
//
// The Lambda is a cargo-lambda-built provided.al2023 arm64 `bootstrap` binary
// at ../target/lambda/bootstrap — build it first with:
//   (cd .. && cargo lambda build --release --arm64)
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";
import { Construct } from "constructs";

const TABLE_NAME = "HotelEvents";

class RustRegisterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new lambda.Function(this, "RustRegister", {
      functionName: "hotel-register-rust",
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: "bootstrap",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "target", "lambda", "bootstrap")),
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      environment: { EVENT_TABLE_NAME: TABLE_NAME },
    });

    // IMPORTANT: the DCB boundary query reads per-axis GSIs (gsi_<axis>).
    // A table-only grant does NOT cover indexes, so we grant the DynamoDB
    // actions on BOTH the table AND its indexes (table/<name>/index/*).
    // (This is the fix for the AccessDeniedException on dynamodb:Query gsi_*.)
    const tableArn = `arn:aws:dynamodb:${this.region}:${this.account}:table/${TABLE_NAME}`;
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:Query",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:TransactWriteItems",
        ],
        resources: [tableArn, `${tableArn}/index/*`],
      })
    );

    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    new cdk.CfnOutput(this, "FunctionUrl", { value: url.url });
    new cdk.CfnOutput(this, "FunctionName", { value: fn.functionName });
  }
}

const app = new cdk.App();
new RustRegisterStack(app, "HotelRustRegister", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
app.synth();
