/**
 * Example agent: gather → label → train → download.
 *
 * Run:
 *   DLF_KEY=dlf_xxx npx tsx examples/simple-agent.ts "fire hydrants in cities"
 *
 * Shows the full pay-per-call lifecycle:
 *   - budget check before starting
 *   - gather 5 images (+10 XP, -100 mcents)
 *   - label each image with OpenRouter Gemma (+20 XP, -200 mcents each)
 *   - start a YOLO training job (+100 XP, -2000 mcents)
 *   - poll status until COMPLETED
 *   - download best.pt weights to disk
 *
 * Total spend on the gateway: ~3100 mcents (~$0.031) per successful run.
 */

import fs from "fs";
import { setTimeout as sleep } from "timers/promises";

const GATEWAY = process.env.DLF_GATEWAY || "https://dlf-gateway.nico-zahniser.workers.dev";
const KEY = process.env.DLF_KEY;
const QUERY = process.argv[2] || "fire hydrants";
const EPOCHS = Number(process.env.EPOCHS || 10);

if (!KEY) {
  console.error("Missing DLF_KEY env var.");
  process.exit(1);
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "dlf-simple-agent/0.1",
      Authorization: `Bearer ${KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  if (r.status === 402) {
    throw new Error(`out of credits: ${text}`);
  }
  if (!r.ok) {
    throw new Error(`${path} HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

async function main() {
  console.log(`→ agent starting: query="${QUERY}" epochs=${EPOCHS}`);

  const bal = await call<{ balance_mcents: number; xp: number; level: number }>("/v1/balance");
  console.log(`  balance: ${bal.balance_mcents} mcents ($${(bal.balance_mcents / 100000).toFixed(5)}), xp=${bal.xp}, level=${bal.level}`);

  // 1) Gather
  const g = await call<any>("/v1/gather", {
    method: "POST",
    body: JSON.stringify({ query: QUERY, max_images: 5 }),
  });
  const imgs = g.upstream?.images || [];
  console.log(`  gather: got ${imgs.length} images; balance=${g.balance_mcents}mc xp=${g.xp}`);

  // 2) Label each
  const labeled: any[] = [];
  for (const [i, img] of imgs.entries()) {
    const l = await call<any>("/v1/label", {
      method: "POST",
      body: JSON.stringify({ path: img.url, queries: QUERY, backend: "openrouter" }),
    });
    const ups = l.upstream || {};
    console.log(`  label[${i}]: detections=${ups.n_detections} elapsed=${ups.elapsed}s balance=${l.balance_mcents}mc`);
    if (ups.n_detections > 0) {
      labeled.push({
        url: img.url,
        image_size: ups.image_size,
        annotations: ups.annotations,
      });
    }
  }

  if (labeled.length < 3) {
    console.error(`only ${labeled.length} usable labels; need at least 3 to train. exiting.`);
    return;
  }

  // 3) Train
  const t = await call<any>("/v1/train-yolo/start", {
    method: "POST",
    body: JSON.stringify({ query: QUERY, epochs: EPOCHS, images: labeled }),
  });
  const jobId = t.upstream?.job_id;
  console.log(`  train: job_id=${jobId} balance=${t.balance_mcents}mc new_badges=${JSON.stringify(t.new_badges)}`);
  if (!jobId) throw new Error("no job_id returned");

  // 4) Poll
  let last = "";
  for (let i = 0; i < 150; i++) {
    const s = await call<any>(`/v1/train-yolo/status/${jobId}`);
    const status = s.upstream?.status;
    if (status !== last) {
      last = status;
      console.log(`  [${i.toString().padStart(3, " ")}] status=${status}`);
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(status)) break;
    await sleep(2000);
  }

  // 5) Download weights
  const weightsResp = await fetch(`${GATEWAY}/v1/train-yolo/weights/${jobId}`, {
    headers: { Authorization: `Bearer ${KEY}`, "User-Agent": "dlf-simple-agent/0.1" },
  });
  if (!weightsResp.ok) {
    throw new Error(`weights fetch failed: HTTP ${weightsResp.status}`);
  }
  const bytes = Buffer.from(await weightsResp.arrayBuffer());
  const filename = `./best_${jobId.slice(0, 8)}.pt`;
  fs.writeFileSync(filename, bytes);
  console.log(`  downloaded ${bytes.length} bytes → ${filename}`);

  const finalProfile = await call<any>("/v1/profile");
  const p = finalProfile.profile;
  console.log(`→ done. final: L${p.level} ${p.xp}XP, balance $${p.balance_usd}, badges=${JSON.stringify(p.badges)}`);
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
