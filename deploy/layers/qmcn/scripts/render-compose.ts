#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfigAt } from "../../../../cli/src/config.ts";
import { dockerServiceEnv } from "../../../../cli/src/backends/docker.ts";
import { orgEnv } from "../../../../cli/src/services.ts";

const layerDir = resolve(dirname(new URL(import.meta.url).pathname), "..");
const { config } = loadConfigAt(join(layerDir, "qm.config.jsonc"));

const HOST_PORT_OFFSET: Record<string, number | undefined> = {
  core: 0,
  portal: 1,
  "web-ui": 2,
  admin: 3,
  auth: undefined,
};
const BASE_PORT = config.basePort ?? 8080;

const SECRETS_BY_SERVICE: Record<string, string[]> = {
  core: [
    "CORE_SIGNING_SECRET",
    "CAPABILITY_SECRET",
    "PORTAL_IDENTITY_SECRET",
    "CONNECTOR_SECRET_KEY",
    "SKILL_SIGNING_SECRET",
    "PUBLIC_API_URL",
    "DATABASE_URL",
  ],
  "web-ui": ["CORE_SIGNING_SECRET", "PORTAL_IDENTITY_SECRET"],
  admin: ["CORE_SIGNING_SECRET"],
  portal: ["CORE_SIGNING_SECRET", "PORTAL_IDENTITY_SECRET", "PORTAL_SESSION_SECRET", "AUTH_CLIENT_SECRET"],
  auth: [
    "CORE_SIGNING_SECRET",
    "AUTH_SIGNING_JWK",
    "AUTH_TOKEN_SECRET",
    "AUTH_CLIENT_SECRET",
    "AUTH_EMAIL_FROM",
    "SMTP_HOST",
    "SMTP_USERNAME",
    "SMTP_PASSWORD",
  ],
};

const SELF_HOSTED_CORE_ENV: Record<string, string> = {
  SANDBOX_BACKEND: "local",
  LOCAL_SANDBOX_IMAGE: "${LOCAL_SANDBOX_IMAGE:-qm-sandbox-local:latest}",
  ARTIFACT_STORE: "postgres",
  SNAPSHOT_STORE: "local",
  TRANSFER_STORE: "local",
};

function coreEnv(): Record<string, string> {
  return {
    ...orgEnv("core", config.orgId, config.publicUrl, config.services.includes("portal")),
    PORT: "8080",
    DATA_DIR: "/data",
    SESSION_STORE: "postgres",
    RUN_STORE: "postgres",
    ...SELF_HOSTED_CORE_ENV,
    ...(config.env.core ?? {}),
  };
}

function envBlock(env: Record<string, string>, secrets: string[], indent: string): string {
  const lines = Object.entries(env).map(([k, v]) => `${indent}  ${k}: ${JSON.stringify(v)}`);
  const secretLines = secrets.map((name) => `${indent}  ${name}: \${${name}:?set ${name} in .env}`);
  return [`${indent}environment:`, ...lines, ...secretLines].join("\n");
}

const services: string[] = [];
for (const service of config.services) {
  if (service === "slack") continue;
  const isCore = service === "core";
  const env = isCore ? coreEnv() : { ...dockerServiceEnv(config, service), ...(config.env[service] ?? {}) };
  const offset = HOST_PORT_OFFSET[service];
  const block: string[] = [
    `  ${service}:`,
    `    image: \${ACR_REGISTRY}/qm-${service}:\${QM_IMAGE_TAG}`,
    `    container_name: ${config.orgId}-${service}`,
    `    restart: unless-stopped`,
    `    networks: [qm]`,
    envBlock(env, SECRETS_BY_SERVICE[service] ?? [], "    "),
  ];
  if (offset !== undefined) block.push(`    ports: ["127.0.0.1:${BASE_PORT + offset}:8080"]`);
  if (isCore) {
    block.push(`    volumes:`);
    block.push(`      - coredata:/data`);
    block.push(`      - /var/run/docker.sock:/var/run/docker.sock`);
    block.push(`      - ./sandbox/skills:/layer/skills:ro`);
    block.push(`      - ./sandbox/tools:/layer/tools:ro`);
  } else {
    block.push(`    depends_on: [core]`);
  }
  services.push(block.join("\n"));
}

const compose = `name: ${config.orgId}

networks:
  qm:
    name: ${config.orgId}

volumes:
  coredata:

services:
${services.join("\n\n")}
`;

writeFileSync(join(layerDir, "docker-compose.yml"), compose);
process.stdout.write(`wrote docker-compose.yml (${config.services.filter((s) => s !== "slack").length} services)\n`);
