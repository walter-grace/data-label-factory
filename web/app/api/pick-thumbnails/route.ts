// /api/pick-thumbnails — extract 5 scored thumbnail candidates from a clip
// using YOLO person prominence + sharpness + composition.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAC_MINI = "bigneek@192.168.1.244";

export async function POST(req: Request) {
    let body: { output_file: string; count?: number };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    const { output_file, count = 5 } = body;

    if (!output_file.startsWith("/tmp/")) {
        return NextResponse.json({ ok: false, error: "invalid file path" }, { status: 400 });
    }

    try {
        const { execSync } = await import("child_process");

        // Write the thumbnail picker script to the Mac mini
        const script = `
import subprocess, os, base64, json, tempfile, sys, shutil

video_path = sys.argv[1]
count = int(sys.argv[2])

probe = subprocess.run([
    "/opt/homebrew/bin/ffprobe", "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    video_path
], capture_output=True, text=True)
duration = float(probe.stdout.strip())

# Extract 15 candidate frames at half resolution for speed
tmpdir = tempfile.mkdtemp(prefix="thumb_")
interval = duration / 16
subprocess.run([
    "/opt/homebrew/bin/ffmpeg", "-hide_banner", "-loglevel", "error",
    "-i", video_path, "-vf", f"fps=1/{interval},scale=540:-2",
    "-frames:v", "15", f"{tmpdir}/frame_%03d.png"
], check=True)

try:
    import cv2
    from ultralytics import YOLO
    model = YOLO("/Users/bigneek/Desktop/ffmpeg-mpc/yolov8n.pt")

    candidates = []
    files = sorted(os.listdir(tmpdir))

    for i, fn in enumerate(files):
        path = os.path.join(tmpdir, fn)
        img = cv2.imread(path)
        if img is None: continue
        h, w = img.shape[:2]
        t = (i + 1) * interval

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        sharpness = cv2.Laplacian(gray, cv2.CV_64F).var()

        results = model(img, classes=[0], verbose=False)
        person_area = 0.0
        person_y = float(h)
        person_cx = w / 2.0
        if len(results[0].boxes) > 0:
            boxes = results[0].boxes.xyxy.cpu().numpy()
            areas = [(b[2]-b[0])*(b[3]-b[1]) for b in boxes]
            j = areas.index(max(areas))
            person_area = max(areas) / (w * h)
            person_y = float(boxes[j][1])
            person_cx = float((boxes[j][0] + boxes[j][2]) / 2)

        prom = min(person_area / 0.4, 1.0)
        upper = 1.0 if person_y < h * 2/3 else 0.5
        central = 1.0 - abs(person_cx - w/2) / (w/2)

        candidates.append({
            "timestamp": round(t, 2),
            "path": path,
            "prom": prom,
            "sharpness_raw": sharpness,
            "upper": upper,
            "central": central,
            "person_area_pct": round(person_area * 100, 1),
        })

    if candidates:
        max_sharp = max(c["sharpness_raw"] for c in candidates) or 1
        for c in candidates:
            c["sharpness"] = c["sharpness_raw"] / max_sharp
            c["score"] = round(
                0.4 * c["prom"] + 0.3 * c["sharpness"] + 0.2 * c["upper"] + 0.1 * c["central"],
                3
            )

    candidates.sort(key=lambda x: -x["score"])
    picked = []
    for c in candidates:
        if all(abs(c["timestamp"] - p["timestamp"]) >= 2.0 for p in picked):
            picked.append(c)
            if len(picked) >= count:
                break

    for p in picked:
        with open(p["path"], "rb") as f:
            p["imageB64"] = base64.b64encode(f.read()).decode()
        del p["path"], p["sharpness_raw"]

    picked.sort(key=lambda x: x["timestamp"])

    # Convert any numpy/np floats to plain python types
    def clean(obj):
        if isinstance(obj, dict):
            return {k: clean(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [clean(v) for v in obj]
        if hasattr(obj, "item"):
            return obj.item()
        return obj

    print(json.dumps({"ok": True, "thumbnails": clean(picked), "duration": float(duration)}))

finally:
    shutil.rmtree(tmpdir, ignore_errors=True)
`.trim();

        execSync(
            `ssh ${MAC_MINI} "cat > /tmp/_thumbnail_picker.py"`,
            { input: script, encoding: "utf-8", timeout: 5000 },
        );

        const result = execSync(
            `ssh ${MAC_MINI} "PATH=/opt/homebrew/bin:\\$PATH /usr/bin/python3 /tmp/_thumbnail_picker.py '${output_file}' ${count}"`,
            { encoding: "utf-8", timeout: 120000, maxBuffer: 50 * 1024 * 1024 },
        );

        const jsonLine = result.trim().split("\n").filter(l => l.startsWith("{")).pop();
        if (!jsonLine) {
            return NextResponse.json({ ok: false, error: "no output from picker" }, { status: 500 });
        }

        return NextResponse.json(JSON.parse(jsonLine));
    } catch (e) {
        return NextResponse.json(
            { ok: false, error: String(e).slice(0, 500) },
            { status: 500 },
        );
    }
}
