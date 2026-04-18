#!/usr/bin/env node
/**
 * create-mcpay <name>
 *
 * Scaffolds a new Cloudflare Worker project with the mcpay agent gateway template.
 */
const fs = require("fs");
const path = require("path");

const name = process.argv[2];
if (!name) {
  console.error("usage: create-mcpay <project-name>");
  process.exit(1);
}

const target = path.resolve(process.cwd(), name);
if (fs.existsSync(target)) {
  console.error(`error: directory "${projectName}" already exists`);
  process.exit(1);
}
// Use the directory's basename as the Worker/package identifier even if the
// user passed a longer path like "./projects/my-api".
const projectName = path.basename(target);

fs.mkdirSync(target, { recursive: true });
fs.mkdirSync(path.join(target, "src"), { recursive: true });

const templateSrc = fs.readFileSync(path.join(__dirname, "..", "src", "template.ts"), "utf8");
fs.writeFileSync(path.join(target, "src", "index.ts"), templateSrc);

fs.writeFileSync(path.join(target, "wrangler.toml"), `name = "${projectName}"
main = "src/index.ts"
compatibility_date = "${new Date().toISOString().slice(0, 10)}"

[[kv_namespaces]]
binding = "KEYS"
id = "CHANGEME_run_wrangler_kv_namespace_create_KEYS"

[[durable_objects.bindings]]
name = "LEADERBOARD"
class_name = "LeaderboardDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["LeaderboardDO"]
`);

fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({
  name: projectName,
  version: "0.1.0",
  private: true,
  scripts: {
    deploy: "wrangler deploy",
    dev: "wrangler dev",
    tail: "wrangler tail",
  },
  devDependencies: {
    "@cloudflare/workers-types": "^4.20240909.0",
    typescript: "^5.5.4",
    wrangler: "^4.0.0",
  },
}, null, 2));

fs.writeFileSync(path.join(target, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ES2022",
    moduleResolution: "bundler",
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    types: ["@cloudflare/workers-types"],
  },
  include: ["src/**/*.ts"],
}, null, 2));

fs.writeFileSync(path.join(target, "README.md"), `# ${projectName}

A pay-per-call agent gateway built on Cloudflare Workers.

Scaffolded with [create-agent-gateway](https://npm.im/create-agent-gateway).

## Setup

\`\`\`bash
npm install
wrangler kv:namespace create KEYS
# Paste the KV id into wrangler.toml
wrangler secret put ADMIN_KEY       # random 32-hex; use for /v1/admin/*
wrangler deploy
\`\`\`

## Next steps

- Replace \`handleExample\` in \`src/index.ts\` with your actual paid tools
- Add x402 signup (see the full example in the data-label-factory repo)
- Ship a \`/llms.txt\` and \`/.well-known/mcp.json\` for Agent Readiness
`);

console.log(`✓ Scaffolded ${projectName}/`);
console.log(`  cd ${projectName} && npm install && wrangler deploy`);
