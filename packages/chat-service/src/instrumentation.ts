/**
 * OpenTelemetry SDK bootstrap with SigV4 OTLP transport.
 *
 * Loaded via Node's --import flag before any app module. This is the
 * recommended OTel pattern (see https://opentelemetry.io/docs/zero-code/js/):
 * instrumentations must patch http / @aws-sdk/* before those modules are
 * imported, so this file must run first — independent of index.ts's
 * ESM static-import order.
 *
 * Credentials are wired lazily via initCredentials() after the entry
 * script has constructed its credential provider — useful when the
 * provider depends on env vars or a custom cred chain.
 *
 * The SDK only starts when OTEL_ENABLED=true; otherwise this module
 * loads but the SDK never boots, so metrics.getMeter() returns a no-op
 * meter throughout. The demo leaves OTEL_ENABLED unset; production sets
 * it.
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { envDetector, hostDetector } from "@opentelemetry/resources";
import {
  ConsoleSpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { AwsInstrumentation } from "@opentelemetry/instrumentation-aws-sdk";
import {
  JsonTraceSerializer,
  JsonMetricsSerializer,
} from "@opentelemetry/otlp-transformer";
import { AwsV4Signer } from "aws4fetch";

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

type CredentialFn = () => Promise<AwsCredentials>;

let credentialFn: CredentialFn | null = null;
let cachedCreds: AwsCredentials | null = null;
let credentialFailureLogged = false;

/** Wire the credential provider. Call once from the entry script after
 *  constructing the desired credential provider. */
export function initCredentials(fn: CredentialFn): void {
  credentialFn = fn;
}

async function getCredentials(): Promise<AwsCredentials> {
  if (!credentialFn) throw new Error("Credential provider not initialized");

  if (
    cachedCreds?.expiration &&
    cachedCreds.expiration.getTime() > Date.now() + 60_000
  ) {
    return cachedCreds;
  }

  const creds = await credentialFn();
  cachedCreds = creds;
  return creds;
}

const region = process.env.AWS_REGION ?? "us-east-1";
const XRAY_ENDPOINT = `https://xray.${region}.amazonaws.com/v1/traces`;
const MONITORING_ENDPOINT = `https://monitoring.${region}.amazonaws.com/v1/metrics`;

async function sigv4Fetch(
  url: string,
  service: string,
  body: Uint8Array,
): Promise<Response> {
  const creds = await getCredentials();
  const signer = new AwsV4Signer({
    url,
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json" }),
    body: body as BodyInit,
    service,
    region,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken !== undefined
      ? { sessionToken: creds.sessionToken }
      : {}),
  });
  const signed = await signer.sign();
  return fetch(signed.url, {
    method: signed.method,
    headers: signed.headers,
    body: signed.body,
  });
}

function handleExportError(
  label: string,
  error: unknown,
  resultCallback: (result: ExportResult) => void,
): void {
  if (!credentialFailureLogged) {
    console.warn(
      `[otel] ${label} — telemetry export disabled:`,
      error instanceof Error ? error.message : error,
    );
    credentialFailureLogged = true;
  }
  resultCallback({ code: ExportResultCode.FAILED });
}

class SigV4TraceExporter implements SpanExporter {
  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    const body = JsonTraceSerializer.serializeRequest(spans);
    if (!body) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }
    sigv4Fetch(XRAY_ENDPOINT, "xray", body)
      .then(async (response) => {
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          console.error(
            `[otel] X-Ray export failed: ${response.status} ${text}`,
          );
          resultCallback({ code: ExportResultCode.FAILED });
        } else {
          resultCallback({ code: ExportResultCode.SUCCESS });
        }
      })
      .catch((error) =>
        handleExportError("Trace export", error, resultCallback),
      );
  }

  async shutdown(): Promise<void> {}
}

class SigV4MetricExporter implements PushMetricExporter {
  export(
    resourceMetrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    const body = JsonMetricsSerializer.serializeRequest(resourceMetrics);
    if (!body) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }
    sigv4Fetch(MONITORING_ENDPOINT, "monitoring", body)
      .then(async (response) => {
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          console.error(
            `[otel] CloudWatch metrics export failed: ${response.status} ${text}`,
          );
          resultCallback({ code: ExportResultCode.FAILED });
        } else {
          resultCallback({ code: ExportResultCode.SUCCESS });
        }
      })
      .catch((error) =>
        handleExportError("Metrics export", error, resultCallback),
      );
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

const useConsole = process.env.OTEL_TRACES_EXPORTER === "console";

const traceExporter: SpanExporter = useConsole
  ? new ConsoleSpanExporter()
  : new SigV4TraceExporter();

const metricReader = new PeriodicExportingMetricReader({
  exporter: useConsole
    ? new ConsoleMetricExporter()
    : new SigV4MetricExporter(),
});

const sdk = new NodeSDK({
  // envDetector reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES.
  // hostDetector adds host.name/host.arch.
  // processDetector is excluded — it adds process.command_args (array)
  // which CloudWatch's OTLP metrics endpoint rejects.
  resourceDetectors: [envDetector, hostDetector],
  traceExporter,
  metricReader,
  instrumentations: [new HttpInstrumentation(), new AwsInstrumentation()],
});

if (process.env.OTEL_ENABLED === "true") {
  sdk.start();
}

export async function shutdownTelemetry(): Promise<void> {
  if (process.env.OTEL_ENABLED === "true") {
    await sdk.shutdown();
  }
}
