#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dockerBasePort, loadConfigAt, securityScreenEnv } from "../../../../cli/src/config.ts";
import { dockerServiceEnv } from "../../../../cli/src/backends/docker.ts";
import { orgEnv, runnableServices, serviceDef, virtualServiceEnv } from "../../../../cli/src/services.ts";
import { computedSecrets, secretDestinations } from "../../../../cli/src/secrets.ts";

const layerDir = resolve(dirname(new URL(import.meta.url).pathname), "..");
const { config } = loadConfigAt(join(layerDir, "qm.config.jsonc"));

const publicUrlOverride = process.env.QM_PUBLIC_URL?.trim();
if (publicUrlOverride) {
  let parsed: URL;
  try {
    parsed = new URL(publicUrlOverride);
  } catch {
    throw new Error(`QM_PUBLIC_URL is not a valid URL: ${publicUrlOverride}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`QM_PUBLIC_URL must be an http(s) URL, got ${parsed.protocol}//`);
  }
  config.publicUrl = publicUrlOverride.replace(/\/$/, "");
}

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

const adminGrants = process.env.QM_ADMIN_GRANTS?.trim();
if (!adminGrants) {
  throw new Error(
    "QM_ADMIN_GRANTS is required: with Postgres, an unset ADMIN_GRANTS seeds zero org admins, " +
      "and registering a model provider from the Admin page is then impossible",
  );
}

const ADMIN_GRANTS: string = adminGrants;
const REMOTE_DIR = process.env.QM_REMOTE_DIR?.trim() || "/opt/qm";
const DATA_DIR = process.env.QM_DATA_DIR?.trim() || "/opt/qm-data";
const LAYER_REL = "deploy/layers/qmcn";
const basePort = dockerBasePort(config);
const CORE_PORT = basePort + (serviceDef("core").docker.hostPortOffset ?? 0);

const allServices = runnableServices(config.services);
const containerServices = allServices.filter((s) => s !== "core");

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
  LOCAL_SANDBOX_IMAGE: "qm-sandbox-local:latest",
  ARTIFACT_STORE: "postgres",
  SNAPSHOT_STORE: "local",
  TRANSFER_STORE: "local",
};

function coreEnv(): Record<string, string> {
  return {
    ...orgEnv("core", config.orgId, config.publicUrl, config.services.includes("portal")),
    PORT: String(CORE_PORT),
    DATA_DIR,
    SESSION_STORE: "postgres",
    RUN_STORE: "postgres",
    ...SELF_HOSTED_CORE_ENV,
    ...(layerMounts.length ? { DEPLOYMENT_LAYER: `${REMOTE_DIR}/${LAYER_REL}/sandbox` } : {}),
    ...(config.model ? { PI_MODEL: config.model } : {}),
    ...(config.modelProvider ? { MODEL_PROVIDER: config.modelProvider } : {}),
    ADMIN_GRANTS,
    ...securityScreenEnv(config),
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
for (const service of containerServices) {
  const def = serviceDef(service);
  const env = {
    ...dockerServiceEnv(config, service),
    CORE_API_URL: `http://host.docker.internal:${CORE_PORT}`,
    ...(config.env[service] ?? {}),
  };
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
  block.push(`    extra_hosts: ["host.docker.internal:host-gateway"]`);
  blocks.push(block.join("\n"));
}

const compose = `name: ${config.orgId}

networks:
  qm:
    name: ${config.orgId}

services:
${blocks.join("\n\n")}
`;

writeFileSync(join(layerDir, "docker-compose.yml"), compose);

const slots = new Map<string, SecretSlot & { services: Set<string> }>();
for (const service of allServices) {
  for (const slot of secretSlotsFor(service)) {
    const existing = slots.get(slot.env);
    if (existing) existing.services.add(service);
    else slots.set(slot.env, { ...slot, services: new Set([service]) });
  }
}
const manifest = [...slots.values()]
  .sort((a, b) => a.env.localeCompare(b.env))
  .map(
    (slot) =>
      `${slot.env}\t${slot.source}\t${slot.required ? "required" : "optional"}\t${[...slot.services].sort().join(",")}`,
  )
  .join("\n");
mkdirSync(join(layerDir, ".generated"), { recursive: true });
writeFileSync(join(layerDir, ".generated", "secret-map"), `${manifest}\n`);

const coreEnvFile = Object.entries(coreEnv())
  .map(([k, v]) => `${k}=${v}`)
  .join("\n");
writeFileSync(join(layerDir, ".generated", "core.env"), `${coreEnvFile}\n`);

process.stdout.write(`wrote docker-compose.yml (${containerServices.length} container services)\n`);
process.stdout.write(`wrote .generated/core.env (core runs on the host)\n`);
process.stdout.write(`wrote .generated/secret-map (${slots.size} env slots)\n`);
process.stdout.write(`CORE_HOST_PORT=${CORE_PORT}\n`);
