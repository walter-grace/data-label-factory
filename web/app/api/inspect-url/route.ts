// /api/inspect-url — server-side: Playwright screenshots a URL, collects DOM
// bounds + computed styles, posts to the upstream identify server for OmniParser
// detection + DOM mapping, returns everything to the browser in one response.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FALCON_URL = process.env.FALCON_URL ?? "http://localhost:8500/api/falcon";

function upstreamBase(): string {
    const u = new URL(FALCON_URL);
    u.pathname = "";
    u.search = "";
    return u.toString().replace(/\/$/, "");
}

export async function POST(req: Request) {
    let body: { url?: string; conf?: number; styles?: boolean; a11y?: boolean };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    const url = body.url;
    if (!url) {
        return NextResponse.json({ ok: false, error: "url required" }, { status: 400 });
    }

    const conf = body.conf ?? 0.05;
    const wantStyles = body.styles ?? true;
    const wantA11y = body.a11y ?? false;

    // ── Step 1: Playwright screenshot + DOM collection ──
    let screenshot: Buffer;
    let domBounds: any[];
    let styleData: any[] | null = null;
    let a11yData: any[] | null = null;
    let rawHtml = "";
    let allDomBounds: any[] = [];
    let pageTitle = "";

    try {
        const { chromium } = await import("playwright");
        const browser = await chromium.launch();
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        // Wait a bit for JS rendering, but don't block on network-idle
        await page.waitForTimeout(2000);
        pageTitle = await page.title();
        screenshot = await page.screenshot({ type: "png" });

        // Collect interactive DOM bounds
        domBounds = await page.evaluate(() => {
            const selectors = "a, button, input, select, textarea, [role=button], nav, header, footer, form, h1, h2, h3, h4, h5, h6, img, section, main";
            const els = document.querySelectorAll(selectors);
            return Array.from(els).slice(0, 300).map((el, i) => {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return null;
                return {
                    selector: el.id ? "#" + el.id
                        : el.tagName.toLowerCase()
                            + (el.className && typeof el.className === "string"
                                ? "." + el.className.trim().split(/\s+/)[0] : "")
                            + ":nth(" + i + ")",
                    tag: el.tagName.toLowerCase(),
                    id: el.id || null,
                    classes: Array.from(el.classList),
                    data_testid: el.getAttribute("data-testid") || null,
                    x1: r.left, y1: r.top, x2: r.right, y2: r.bottom,
                    text: el.textContent ? el.textContent.trim().slice(0, 80) : null,
                };
            }).filter(x => x !== null);
        });

        // Optional: computed styles
        if (wantStyles) {
            styleData = await page.evaluate(() => {
                const selectors = "a, button, input, select, textarea, [role=button], h1, h2, h3, h4, h5, h6, nav, header, footer, main, section, form, img";
                const els = document.querySelectorAll(selectors);
                return Array.from(els).slice(0, 200).map((el, i) => {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) return null;
                    const cs = window.getComputedStyle(el);
                    return {
                        selector: el.id ? "#" + el.id
                            : el.tagName.toLowerCase()
                                + (el.className && typeof el.className === "string"
                                    ? "." + el.className.trim().split(/\s+/)[0] : "")
                                + ":nth(" + i + ")",
                        tag: el.tagName.toLowerCase(),
                        x1: r.left, y1: r.top, x2: r.right, y2: r.bottom,
                        styles: {
                            fontSize: cs.fontSize,
                            fontWeight: cs.fontWeight,
                            fontFamily: cs.fontFamily,
                            color: cs.color,
                            backgroundColor: cs.backgroundColor,
                            padding: cs.padding,
                            margin: cs.margin,
                            border: cs.border,
                            borderRadius: cs.borderRadius,
                            display: cs.display,
                            width: cs.width,
                            height: cs.height,
                        },
                    };
                }).filter(x => x !== null);
            });
        }

        // Collect full page HTML
        rawHtml = await page.evaluate(() => document.documentElement.outerHTML);
        // Also collect ALL elements with bboxes (for draw-to-select matching)
        allDomBounds = await page.evaluate(() => {
            const all = document.querySelectorAll("*");
            return Array.from(all).slice(0, 1000).map((el, i) => {
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return null;
                const cs = window.getComputedStyle(el);
                if (cs.display === "none" || cs.visibility === "hidden") return null;
                return {
                    selector: el.id ? "#" + el.id
                        : el.tagName.toLowerCase()
                            + (el.className && typeof el.className === "string"
                                ? "." + el.className.trim().split(/\s+/)[0] : "")
                            + ":nth(" + i + ")",
                    tag: el.tagName.toLowerCase(),
                    id: el.id || null,
                    classes: Array.from(el.classList).slice(0, 5),
                    x1: r.left, y1: r.top, x2: r.right, y2: r.bottom,
                    text: el.textContent ? el.textContent.trim().slice(0, 100) : null,
                    styles: {
                        fontSize: cs.fontSize,
                        fontWeight: cs.fontWeight,
                        color: cs.color,
                        backgroundColor: cs.backgroundColor,
                        padding: cs.padding,
                        display: cs.display,
                    },
                };
            }).filter(x => x !== null);
        });

        await browser.close();
    } catch (e) {
        return NextResponse.json(
            { ok: false, error: `screenshot failed: ${String(e)}` },
            { status: 502 },
        );
    }

    // ── Step 2: POST to upstream /api/webui/map ──
    const upstream = upstreamBase();
    let mapped: any;
    try {
        const formData = new FormData();
        formData.set("image", new Blob([screenshot as BlobPart], { type: "image/png" }), "screenshot.png");
        formData.set("dom_bounds", JSON.stringify(domBounds));
        formData.set("conf", String(conf));

        const r = await fetch(`${upstream}/api/webui/map`, {
            method: "POST",
            body: formData,
        });
        mapped = await r.json();
    } catch (e) {
        return NextResponse.json(
            { ok: false, error: `upstream detection failed: ${String(e)}` },
            { status: 502 },
        );
    }

    // ── Step 3: Enrich with styles ──
    if (styleData && mapped?.mapped) {
        const styleLookup: Record<string, any> = {};
        for (const s of styleData) {
            if (s?.selector) styleLookup[s.selector] = s.styles;
        }
        for (const m of mapped.mapped) {
            const st = styleLookup[m.selector];
            if (st) m.styles = st;
        }
    }

    // ── Step 4: Return everything ──
    // Trim HTML to avoid massive payloads (keep first 200KB)
    const trimmedHtml = rawHtml.length > 200_000
        ? rawHtml.slice(0, 200_000) + "\n<!-- ... truncated -->"
        : rawHtml;

    return NextResponse.json({
        ok: true,
        url,
        title: pageTitle,
        screenshot_base64: screenshot.toString("base64"),
        dom_count: domBounds.length,
        all_dom_count: allDomBounds.length,
        detection: mapped,
        styles: styleData,
        a11y: a11yData,
        html: trimmedHtml,
        all_dom_bounds: allDomBounds,
    });
}
