import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "path";

export interface StaticSiteStackProps extends cdk.StackProps {
  /**
   * Optional custom domain name (e.g. "event-model.example.com").
   * If not provided, the CloudFront distribution URL is used.
   */
  domainName?: string;
}

export class StaticSiteStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly siteBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StaticSiteStackProps) {
    super(scope, id, props);

    // ─────────────────────────────────────────────────────────────────────────
    // S3 Bucket — private, CloudFront-only access via OAC
    // ─────────────────────────────────────────────────────────────────────────
    this.siteBucket = new s3.Bucket(this, "SiteBucket", {
      bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          // Clean up old versions after 30 days to control costs
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Response Headers Policy — security headers (OWASP best practices)
    // ─────────────────────────────────────────────────────────────────────────
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      "SecurityHeadersPolicy",
      {
        responseHeadersPolicyName: `${this.stackName}-SecurityHeaders`,
        securityHeadersBehavior: {
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(365 * 2),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          xssProtection: {
            protection: true,
            modeBlock: true,
            override: true,
          },
        },
        customHeadersBehavior: {
          customHeaders: [
            {
              header: "Permissions-Policy",
              value:
                "camera=(), microphone=(), geolocation=(), payment=()",
              override: true,
            },
            {
              header: "X-Robots-Tag",
              value: "index, follow",
              override: true,
            },
          ],
        },
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Cache Policy — optimized for static assets with long TTL
    // ─────────────────────────────────────────────────────────────────────────
    const cachePolicy = new cloudfront.CachePolicy(this, "CachePolicy", {
      cachePolicyName: `${this.stackName}-StaticAssets`,
      comment: "Cache policy for mermaid-event-model static assets",
      defaultTtl: cdk.Duration.days(1),
      maxTtl: cdk.Duration.days(365),
      minTtl: cdk.Duration.seconds(0),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // CloudFront Distribution
    // ─────────────────────────────────────────────────────────────────────────
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "Mermaid Event Model — Interactive Event Modeling Diagrams",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy,
        responseHeadersPolicy,
        compress: true,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(5),
        },
      ],
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableLogging: false,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // S3 Deployment — uploads _site/ contents and invalidates CloudFront cache
    // ─────────────────────────────────────────────────────────────────────────
    const siteDir = path.join(__dirname, "..", "..", "_site");

    // This is a no-build site: model-viewer.html imports .js modules directly
    // by name (no content-hashed filenames). A long TTL on those files lets a
    // browser pair a fresh HTML with a stale cached module (or vice versa),
    // which breaks ES module imports. So HTML/JS are served `no-cache`
    // (cached but always revalidated via ETag), while immutable-ish assets
    // (images) and content files (md/json) get longer TTLs.
    //
    // Deployed in two passes over the same asset. The first pass owns
    // `prune` (removing files deleted from _site); the second must not prune,
    // or the passes would delete each other's objects.
    const commonDeployProps = {
      sources: [s3deploy.Source.asset(siteDir)],
      destinationBucket: this.siteBucket,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      memoryLimit: 512,
    };

    // Pass 1 — HTML + JS: always revalidate so imports never desync.
    new s3deploy.BucketDeployment(this, "DeploySiteRevalidated", {
      ...commonDeployProps,
      prune: true,
      exclude: ["*"],
      include: ["*.html", "*.js"],
      cacheControl: [
        s3deploy.CacheControl.setPublic(),
        s3deploy.CacheControl.noCache(),
        s3deploy.CacheControl.mustRevalidate(),
      ],
    });

    // Pass 2 — everything else (images, .md, .json, etc.): cacheable.
    new s3deploy.BucketDeployment(this, "DeploySiteCached", {
      ...commonDeployProps,
      prune: false,
      exclude: ["*.html", "*.js"],
      cacheControl: [
        s3deploy.CacheControl.setPublic(),
        s3deploy.CacheControl.maxAge(cdk.Duration.hours(1)),
      ],
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GitHub Actions OIDC — for CI/CD without long-lived credentials
    // ─────────────────────────────────────────────────────────────────────────
    const ghProvider = new iam.OpenIdConnectProvider(this, "GitHubOIDC", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
      thumbprints: [
        "6938fd4d98bab03faadb97b34396831e3780aea1",
        "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
      ],
    });

    // The GitHub repo (owner/name) allowed to assume the deploy role via OIDC.
    // Override with:  cdk deploy -c githubRepo=owner/name
    const githubRepo =
      (this.node.tryGetContext("githubRepo") as string | undefined) ||
      process.env.GITHUB_REPOSITORY ||
      "patrocinio/mermaid-event-model";

    const deployRole = new iam.Role(this, "GitHubActionsDeployRole", {
      roleName: `${this.stackName}-GitHubActionsDeployRole`,
      assumedBy: new iam.WebIdentityPrincipal(
        ghProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            "token.actions.githubusercontent.com:sub": `repo:${githubRepo}:*`,
          },
        }
      ),
      description:
        "Role assumed by GitHub Actions to deploy the static site",
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // Grant deploy role permissions for S3 and CloudFront
    this.siteBucket.grantReadWrite(deployRole);
    this.siteBucket.grantDelete(deployRole);
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "cloudfront:CreateInvalidation",
          "cloudfront:GetInvalidation",
          "cloudfront:ListInvalidations",
        ],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${this.distribution.distributionId}`,
        ],
      })
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Outputs
    // ─────────────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "DistributionUrl", {
      value: `https://${this.distribution.distributionDomainName}`,
      description: "CloudFront distribution URL for the event model viewer",
      exportName: `${this.stackName}-DistributionUrl`,
    });

    new cdk.CfnOutput(this, "DistributionId", {
      value: this.distribution.distributionId,
      description: "CloudFront distribution ID (for cache invalidation)",
      exportName: `${this.stackName}-DistributionId`,
    });

    new cdk.CfnOutput(this, "BucketName", {
      value: this.siteBucket.bucketName,
      description: "S3 bucket name for the static site",
      exportName: `${this.stackName}-BucketName`,
    });

    new cdk.CfnOutput(this, "DeployRoleArn", {
      value: deployRole.roleArn,
      description: "IAM role ARN for GitHub Actions OIDC deployment",
      exportName: `${this.stackName}-DeployRoleArn`,
    });
  }
}
