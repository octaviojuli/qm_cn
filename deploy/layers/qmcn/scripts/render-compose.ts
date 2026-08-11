#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dockerBasePort, loadConfigAt } from "../../../../cli/src/config.ts";
import { dockerServiceEnv } from "../../../../cli/src/backends/docker.ts";
import { orgEnv, runnableServices, serviceDef, virtualServiceEnv } from "../../../../cli/src/services.ts";
import { computedSecrets, secretDestinations } from "../../../../cli/src/secrets.ts";

const layerDir = resolve(dirname(new URL(import.meta.url).pathname), "..");
const { config } = loadConfigAt(join(layerDir, "qm.config.jsonc"));

const publicUrlOverride = process.env.QM_PUBLIC_URL?.trim();
if (publicUrlOverride) config.publicUrl = publicUrlOverride.replace(/\/$/, "");

const emailDomainOverride = process.env.QM_AUTH_EMAIL_DOMAIN?.trim();
if (emailDomainOverride) {
  if (!config.env.auth) {
    throw new Error("QM_AUTH_EMAIL_DOMAIN is set but the config has no env.auth block to apply it to");
  }
  config.env.auth.AUTH_ALLOWED_EMAIL_DOMAIN = emailDomainOverride;
}

for (const [service, env] of Object.entries(config.env)) {
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value.includes("REPLACE-WITH")) {
      throw new Error(`env.${service}.${key} still holds a placeholder: ${value}`);
    }
  }
}
if (config.publicUrl.includes("REPLACE-WITH")) {
  throw new Error(`publicUrl still holds a placeholder: ${config.publicUrl} (set QM_PUBLIC_URL)`);
}

const services = runnableServices(config.services);
const basePort = dockerBasePort(config);

interface SecretSlot {
  env: string;
  source: string;
  required: boolean;
}

const DATABASE_URL_SLOT: SecretSlot = { env: "DATABASE_URL", source: "DATABASE_URL", required: true };

const secretSlotsFor = (service: string): SecretSlot[] => {
  const slots = new Map<string, SecretSlot>();
  for (const secret of computedSecrets(config)) {
    for (const env of secretDestinations(secret).get(service) ?? []) {
      slots.set(env, { env, source: secret.name, required: secret.required });
    }
  }
  if (service === "core") slots.set(DATABASE_URL_SLOT.env, DATABASE_URL_SLOT);
  return [...slots.values()].sort((a, b) => a.env.localeCompare(b.env));
};

const layerMounts = (["skills", "tools"] as const).filter((sub) => existsSync(join(layerDir, "sandbox", sub)));

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
    PORT: String(serviceDef("core").docker.internalPort),
    DATA_DIR: "/data",
    SESSION_STORE: "postgres",
    RUN_STORE: "postgres",
    ...SELF_HOSTED_CORE_ENV,
    ...(layerMounts.length ? { DEPLOYMENT_LAYER: "/layer" } : {}),
    ...virtualServiceEnv(config.services, config.env),
    ...(config.env.core ?? {}),
  };
}

function envBlock(env: Record<string, string>, secrets: SecretSlot[], indent: string): string {
  const lines = Object.entries(env).map(([k, v]) => `${indent}  ${k}: ${JSON.stringify(v)}`);
  const secretLines = secrets.map(
    (slot) => `${indent}  ${slot.env}: \${${slot.env}${slot.required ? `:?set ${slot.env} in .env` : ":-"}}`,
  );
  return [`${indent}environment:`, ...lines, ...secretLines].join("\n");
}

const blocks: string[] = [];
for (const service of services) {
  const isCore = service === "core";
  const def = serviceDef(service);
  const env = isCore ? coreEnv() : { ...dockerServiceEnv(config, service), ...(config.env[service] ?? {}) };
  const block: string[] = [
    `  ${service}:`,
    `    image: qm-${service}:local`,
    `    build:`,
    `      context: ../../..`,
    `      dockerfile: deploy/${service}/Dockerfile`,
    `    container_name: ${config.orgId}-${service}`,
    `    restart: unless-stopped`,
    `    networks: [qm]`,
    envBlock(env, secretSlotsFor(service), "    "),
  ];
  if (def.docker.hostPortOffset !== undefined) {
    block.push(`    ports: ["127.0.0.1:${basePort + def.docker.hostPortOffset}:${def.docker.internalPort}"]`);
  }
  if (isCore) {
    block.push(`    volumes:`);
    block.push(`      - coredata:/data`);
    block.push(`      - /var/run/docker.sock:/var/run/docker.sock`);
    for (const sub of layerMounts) block.push(`      - ./sandbox/${sub}:/layer/${sub}:ro`);
  } else {
    block.push(`    depends_on: [core]`);
  }
  blocks.push(block.join("\n"));
}

const compose = `name: ${config.orgId}

networks:
  qm:
    name: ${config.orgId}

volumes:
  coredata:

services:
${blocks.join("\n\n")}
`;

writeFileSync(join(layerDir, "docker-compose.yml"), compose);

const slots = new Map<string, SecretSlot>();
for (const service of services) {
  for (const slot of secretSlotsFor(service)) slots.set(slot.env, slot);
}
const manifest = [...slots.values()]
  .sort((a, b) => a.env.localeCompare(b.env))
  .map((slot) => `${slot.env}\t${slot.source}\t${slot.required ? "required" : "optional"}`)
  .join("\n");
mkdirSync(join(layerDir, ".generated"), { recursive: true });
writeFileSync(join(layerDir, ".generated", "secret-map"), `${manifest}\n`);

const corePort = basePort + (serviceDef("core").docker.hostPortOffset ?? 0);
process.stdout.write(`wrote docker-compose.yml (${services.length} services)\n`);
process.stdout.write(`wrote .generated/secret-map (${slots.size} env slots)\n`);
process.stdout.write(`CORE_HOST_PORT=${corePort}\n`);
