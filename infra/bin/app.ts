#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { StaticSiteStack } from "../lib/static-site-stack";

const app = new cdk.App();

new StaticSiteStack(app, "MermaidEventModelSite", {
  description:
    "Mermaid Event Model — Interactive event modeling diagrams with SVG rendering, deployed via CloudFront + S3",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
  tags: {
    Project: "mermaid-event-model",
    ManagedBy: "aws-cdk",
    Repository: "howarddierking/mermaid-event-model",
  },
});
