// /api/pipeline-run — runs the auto-research pipeline and streams progress via SSE.
// Handles each step inline (no subprocess) so we can stream granular updates.

import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes

const FALCON_URL = process.env.FALCON_URL ?? "http://localhost:8500/api/falcon";
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const LLM_MODEL = process.env.LLM_MODEL ?? "google/gemma-4-26b-a4b-it";

function upstreamBase(): string {
    const u = new URL(FALCON_URL);
    u.pathname = "";
    u.search = "";
    return u.toString().replace(/\/$/, "");
}

// Top Product Hunt products + best SaaS landing pages for UI research
const SEED_URLS = [
    // #1-10: Top PH products (their actual websites, not PH pages)
    "https://cursor.com",
    "https://v0.dev",
    "https://lovable.dev",
    "https://bolt.new",
    "https://perplexity.ai",
    "https://replit.com",
    "https://gamma.app",
    "https://descript.com",
    "https://tldraw.com",
    "https://excalidraw.com",
    // #11-20: Top SaaS with great landing pages
    "https://linear.app",
    "https://vercel.com",
    "https://stripe.com",
    "https://supabase.com",
    "https://clerk.com",
    "https://resend.com",
    "https://cal.com",
    "https://dub.co",
    "https://posthog.com",
    "https://trigger.dev",
    // #21-30: Design references + competitors
    "https://midday.ai",
    "https://ui.shadcn.com",
    "https://tailwindcss.com",
    "https://nextjs.org",
    "https://framer.com",
    "https://roboflow.com",
    "https://huggingface.co",
    "https://replicate.com",
    "https://modal.com",
    "https://runpod.io",
];

type SSEEvent = {
    event: string;
    data: Record<string, unknown>;
};

// Crawl a site: homepage + internal pages → multiple screenshots
async function crawlSite(siteUrl: string, maxPages: number = 5): Promise<{
    pages: { url: string; title: string; screenshot: Buffer; domBounds: any[] }[];
    error?: string;
}> {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const results: { url: string; title: string; screenshot: Buffer; domBounds: any[] }[] = [];

    try {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        });
        const page = await context.newPage();
        const origin = new URL(siteUrl).origin;
        const visited = new Set<string>();

        // Helper: screenshot + collect DOM for current page
        async function capturePage(pageUrl: string) {
            if (visited.has(pageUrl) || results.length >= maxPages) return;
            visited.add(pageUrl);

            try {
                await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 20000 });
                await page.waitForTimeout(3000);
                const title = await page.title();
                const screenshot = await page.screenshot({ type: "png" });

                const domBounds = await page.evaluate(() => {
                    const selectors = "a, button, input, select, textarea, [role=button], nav, header, footer, form, h1, h2, h3, h4, h5, h6, img, section, main";
                    const els = document.querySelectorAll(selectors);
                    return Array.from(els).slice(0, 200).map((el, idx) => {
                        const r = el.getBoundingClientRect();
                        if (r.width < 2 || r.height < 2) return null;
                        return {
                            selector: el.id ? "#" + el.id
                                : el.tagName.toLowerCase()
                                    + (el.className && typeof el.className === "string"
                                        ? "." + el.className.trim().split(/\s+/)[0] : "")
                                    + ":nth(" + idx + ")",
                            tag: el.tagName.toLowerCase(),
                            id: el.id || null,
                            x1: r.left, y1: r.top, x2: r.right, y2: r.bottom,
                        };
                    }).filter(x => x !== null);
                });

                results.push({ url: pageUrl, title, screenshot, domBounds });
            } catch {
                // Skip pages that fail to load
            }
        }

        // Capture homepage first
        await capturePage(siteUrl);

        // Find internal links to explore
        if (results.length > 0 && results.length < maxPages) {
            const internalLinks: string[] = await page.evaluate((orig: string) => {
                const links = document.querySelectorAll("a[href]");
                const seen = new Set<string>();
                const results: string[] = [];
                links.forEach((a) => {
                    try {
                        const href = new URL((a as HTMLAnchorElement).href);
                        if (href.origin === orig && !seen.has(href.pathname) && href.pathname !== "/" && !href.pathname.match(/\.(pdf|zip|png|jpg|svg|ico)$/)) {
                            seen.add(href.pathname);
                            results.push(href.href);
                        }
                    } catch {}
                });
                return results.slice(0, 20);
            }, origin);

            // Visit top internal pages
            for (const link of internalLinks.slice(0, maxPages - 1)) {
                if (results.length >= maxPages) break;
                await capturePage(link);
            }
        }
    } catch (e) {
        return { pages: results, error: String(e) };
    } finally {
        await browser.close();
    }

    return { pages: results };
}

export async function GET(req: Request) {
    const url = new URL(req.url);
    const count = Math.min(parseInt(url.searchParams.get("count") ?? "20"), 200);
    const skipGemma = url.searchParams.get("skipGemma") === "true";
    const crawlDepth = Math.min(parseInt(url.searchParams.get("crawlDepth") ?? "1"), 10);
    const source = url.searchParams.get("source") ?? "curated";
    const upstream = upstreamBase();

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            function send(event: string, data: Record<string, unknown>) {
                const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
                try { controller.enqueue(encoder.encode(frame)); } catch { /* closed */ }
            }

            send("start", { count, skipGemma, timestamp: Date.now() });

            // Select URLs
            const urls = SEED_URLS.slice(0, count);
            send("urls", { count: urls.length, urls: urls.slice(0, 10) });

            let okCount = 0;
            let failCount = 0;
            const results: Record<string, unknown>[] = [];

            // Process each URL
            for (let i = 0; i < urls.length; i++) {
                const siteUrl = urls[i];
                const hash = crypto.createHash("sha1").update(siteUrl).digest("hex").slice(0, 12);

                send("progress", {
                    step: "screenshot",
                    index: i,
                    total: urls.length,
                    url: siteUrl,
                    pct: Math.round((i / urls.length) * 100),
                });

                try {
                    // Step 1: Crawl site — homepage + internal pages
                    const crawlResult = await crawlSite(siteUrl, crawlDepth);
                    if (crawlResult.pages.length === 0) {
                        failCount++;
                        send("error", { index: i, url: siteUrl, error: crawlResult.error ?? "no pages captured" });
                        continue;
                    }

                    send("screenshot", {
                        index: i,
                        url: siteUrl,
                        hash,
                        title: crawlResult.pages[0].title,
                        domCount: crawlResult.pages[0].domBounds.length,
                        pagesFound: crawlResult.pages.length,
                    });

                    // Process each captured page
                    for (let pi = 0; pi < crawlResult.pages.length; pi++) {
                    const cp = crawlResult.pages[pi];
                    const pageHash = hash + (pi > 0 ? `_p${pi}` : "");
                    const screenshotB64 = Buffer.from(cp.screenshot).toString("base64");
                    const title = cp.title;
                    const domBounds = cp.domBounds;

                    // Step 2: OmniParser labeling
                    send("progress", { step: "omniparser", index: i, total: urls.length, url: siteUrl });

                    const formData = new FormData();
                    const uint8 = new Uint8Array(cp.screenshot.buffer, cp.screenshot.byteOffset, cp.screenshot.byteLength);
                    formData.set("image", new Blob([uint8] as BlobPart[], { type: "image/png" }), "screenshot.png");
                    formData.set("dom_bounds", JSON.stringify(domBounds));
                    formData.set("conf", "0.05");

                    let omniData: any = { mapped: [] };
                    let omniCount = 0;
                    try {
                        const omniResp = await fetch(`${upstream}/api/webui/map`, { method: "POST", body: formData, signal: AbortSignal.timeout(10000) });
                        if (omniResp.ok) {
                            omniData = await omniResp.json();
                            omniCount = omniData?.mapped?.length ?? omniData?.elements?.length ?? 0;
                        }
                    } catch {
                        // OmniParser/identify server not running — use DOM bounds as elements instead
                        omniData = { mapped: domBounds.map((d: any) => ({ ...d, label: d.tag, source: "dom" })) };
                        omniCount = domBounds.length;
                    }

                    send("labeled", {
                        index: i,
                        url: cp.url,
                        hash: pageHash,
                        title,
                        screenshotB64,
                        omniCount,
                        omniElements: omniData?.mapped ?? omniData?.elements ?? [],
                        domBounds,
                        elapsed: omniData?.elapsed_seconds,
                        pageIndex: pi,
                        totalPages: crawlResult.pages.length,
                    });

                    const entry: Record<string, unknown> = {
                        url: cp.url, hash: pageHash, title, omniCount, domCount: domBounds.length,
                    };

                    // Step 3: Gemma augmentation (optional)
                    if (!skipGemma && LLM_API_KEY) {
                        send("progress", { step: "gemma", index: i, total: urls.length, url: siteUrl });

                        try {
                            const existingDesc = (omniData?.mapped ?? []).slice(0, 20).map((m: any) =>
                                `<${m.tag}> at (${m.bbox_norm?.x1?.toFixed(2)},${m.bbox_norm?.y1?.toFixed(2)})`
                            ).join("\n");

                            const gemmaResp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
                                method: "POST",
                                headers: {
                                    "Authorization": `Bearer ${LLM_API_KEY}`,
                                    "Content-Type": "application/json",
                                    "HTTP-Referer": "https://github.com/walter-grace/mac-code",
                                },
                                body: JSON.stringify({
                                    model: LLM_MODEL,
                                    messages: [
                                        { role: "system", content: "You label web UI elements. For each missed element output a JSON: {\"x1\":0.1,\"y1\":0.2,\"x2\":0.5,\"y2\":0.3,\"label\":\"heading\"}. Only JSON lines, no explanation." },
                                        { role: "user", content: [
                                            { type: "image_url", image_url: { url: `data:image/png;base64,${screenshotB64}` } },
                                            { type: "text", text: `Already detected (${omniCount}):\n${existingDesc}\n\nFind 5-10 missed elements.` },
                                        ]},
                                    ],
                                    max_tokens: 512,
                                    temperature: 0.2,
                                }),
                            });

                            if (gemmaResp.ok) {
                                const gemmaData = await gemmaResp.json();
                                const reply = gemmaData.choices?.[0]?.message?.content ?? "";
                                const added: unknown[] = [];
                                const jsonRegex = /\{[^{}]*"x1"[^{}]*\}/g;
                                let m;
                                while ((m = jsonRegex.exec(reply)) !== null) {
                                    try { added.push(JSON.parse(m[0])); } catch {}
                                }
                                entry.gemmaAdded = added.length;
                                entry.gemmaTotal = omniCount + added.length;
                                send("gemma", { index: i, url: siteUrl, added: added.length, total: omniCount + added.length, gemmaElements: added });
                            }
                        } catch (e) {
                            send("gemma_error", { index: i, url: siteUrl, error: String(e) });
                        }
                    }

                    results.push(entry);
                    okCount++;

                    } // end inner page loop

                } catch (e) {
                    failCount++;
                    send("error", { index: i, url: siteUrl, error: String(e) });
                }
            }

            // Final stats
            const totalOmni = results.reduce((s, r) => s + ((r.omniCount as number) ?? 0), 0);
            const totalGemma = results.reduce((s, r) => s + ((r.gemmaTotal as number) ?? (r.omniCount as number) ?? 0), 0);
            send("complete", {
                ok: okCount,
                fail: failCount,
                totalOmni,
                totalGemma,
                avgOmni: okCount > 0 ? (totalOmni / okCount).toFixed(1) : 0,
                avgGemma: okCount > 0 ? (totalGemma / okCount).toFixed(1) : 0,
                gemmaAdded: totalGemma - totalOmni,
            });

            controller.close();
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}
