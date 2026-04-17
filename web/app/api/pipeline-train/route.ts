// /api/pipeline-train — receives labeled training data (screenshots + YOLO labels),
// uploads to Mac mini, trains a YOLO model, and swaps Falcon to use it.
//
// This is the training step that closes the auto-research loop:
//   scrape → label → augment → TRAIN → swap model → repeat
//
// POST body: { images: [{hash, screenshotB64, labels: "0 cx cy w h\n..."}], epochs, cycle }

import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAC_MINI = process.env.MAC_MINI_SSH ?? "bigneek@192.168.1.244";
const REMOTE_DIR = "~/dlf-training";

export async function POST(req: Request) {
    let body: {
        images: { hash: string; screenshotB64: string; labels: string }[];
        epochs?: number;
        cycle?: number;
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    const { images, epochs = 20, cycle = 0 } = body;
    if (!images || images.length === 0) {
        return NextResponse.json({ ok: false, error: "no images" }, { status: 400 });
    }

    const runName = `cycle_${String(cycle).padStart(3, "0")}`;

    try {
        // 1. Create local temp dataset in YOLO format
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yolo-train-"));
        const trainImgDir = path.join(tmpDir, "images", "train");
        const trainLblDir = path.join(tmpDir, "labels", "train");
        const valImgDir = path.join(tmpDir, "images", "val");
        const valLblDir = path.join(tmpDir, "labels", "val");
        fs.mkdirSync(trainImgDir, { recursive: true });
        fs.mkdirSync(trainLblDir, { recursive: true });
        fs.mkdirSync(valImgDir, { recursive: true });
        fs.mkdirSync(valLblDir, { recursive: true });

        // Split 90/10 train/val
        const valCount = Math.max(1, Math.floor(images.length * 0.1));
        const shuffled = [...images].sort(() => Math.random() - 0.5);

        for (let i = 0; i < shuffled.length; i++) {
            const img = shuffled[i];
            const isVal = i < valCount;
            const imgDir = isVal ? valImgDir : trainImgDir;
            const lblDir = isVal ? valLblDir : trainLblDir;

            // Save image
            const imgBuf = Buffer.from(img.screenshotB64, "base64");
            fs.writeFileSync(path.join(imgDir, `${img.hash}.png`), imgBuf);

            // Save labels
            if (img.labels && img.labels.trim()) {
                fs.writeFileSync(path.join(lblDir, `${img.hash}.txt`), img.labels);
            }
        }

        // Write data.yaml
        const yamlContent = `path: ${REMOTE_DIR}/${runName}/dataset\ntrain: images/train\nval: images/val\nnc: 1\nnames: ['ui_element']\n`;
        fs.writeFileSync(path.join(tmpDir, "data.yaml"), yamlContent);

        const trainCount = shuffled.length - valCount;

        // 2. Upload to Mac mini
        execSync(`ssh ${MAC_MINI} "mkdir -p ${REMOTE_DIR}/${runName}/dataset"`, { timeout: 10000 });
        execSync(`rsync -az ${tmpDir}/ ${MAC_MINI}:${REMOTE_DIR}/${runName}/dataset/`, { timeout: 60000 });

        // 3. Train on Mac mini
        const trainCmd = [
            `cd ${REMOTE_DIR}/${runName}`,
            `python3 -c "`,
            `from ultralytics import YOLO`,
            `model = YOLO('yolov8n.pt')`,
            `model.train(data='dataset/data.yaml', epochs=${epochs}, imgsz=640, batch=8,`,
            `  project='runs', name='${runName}', exist_ok=True)`,
            `print('TRAINING_COMPLETE')`,
            `"`,
        ].join("\n");

        const trainResult = execSync(`ssh ${MAC_MINI} '${trainCmd}'`, {
            timeout: 600000, // 10 min max
            encoding: "utf-8",
        });

        const success = trainResult.includes("TRAINING_COMPLETE");

        if (!success) {
            return NextResponse.json({
                ok: false,
                error: "training did not complete",
                output: trainResult.slice(-500),
            });
        }

        // 4. Check if best.pt exists
        const bestPath = `${REMOTE_DIR}/${runName}/runs/${runName}/weights/best.pt`;
        try {
            execSync(`ssh ${MAC_MINI} "ls ${bestPath}"`, { timeout: 5000 });
        } catch {
            return NextResponse.json({
                ok: false,
                error: "best.pt not found after training",
            });
        }

        // 5. Swap Falcon to use the new model
        try {
            // Kill old server, start with new model
            const swapCmd = [
                `lsof -ti :8500 | xargs kill -9 2>/dev/null; sleep 2`,
                `cd ~/dlf-yolo-world && PYTHONPATH=. nohup python3 -m data_label_factory.identify.serve`,
                `  --index card_index_v2.npz --projection clip_proj_v2.pt --refs refs-all`,
                `  --prices card_prices.json --port 8500`,
                `  --omniparser ${bestPath}`,
                `  > server_webui.log 2>&1 &`,
                `sleep 10`,
                `curl -s http://localhost:8500/health | head -1`,
            ].join(" ");

            const swapResult = execSync(`ssh ${MAC_MINI} "${swapCmd}"`, {
                timeout: 30000,
                encoding: "utf-8",
            });

            return NextResponse.json({
                ok: true,
                cycle,
                trainImages: trainCount,
                valImages: valCount,
                epochs,
                modelPath: bestPath,
                serverSwapped: swapResult.includes("ready"),
                runName,
            });
        } catch (e) {
            return NextResponse.json({
                ok: true,
                cycle,
                trainImages: trainCount,
                valImages: valCount,
                epochs,
                modelPath: bestPath,
                serverSwapped: false,
                swapError: String(e),
                runName,
            });
        }

    } catch (e) {
        return NextResponse.json(
            { ok: false, error: `training failed: ${String(e).slice(0, 500)}` },
            { status: 500 },
        );
    }
}
