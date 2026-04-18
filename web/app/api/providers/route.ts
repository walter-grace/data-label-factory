import { NextResponse } from "next/server";

export async function GET() {
  const hasOpenRouter = !!process.env.LLM_API_KEY;
  const hasFalcon = !!process.env.FALCON_PROXY_URL;
  return NextResponse.json({
    providers: [
      { name: "auto", alive: hasFalcon && hasOpenRouter, capabilities: ["label"] },
      { name: "openrouter", alive: hasOpenRouter, capabilities: ["filter", "label", "verify"] },
      { name: "falcon", alive: hasFalcon, capabilities: ["filter", "label", "verify"] },
      { name: "gemma", alive: false, capabilities: ["filter", "label"] },
      { name: "liteparse", alive: false, capabilities: ["parse"] },
      { name: "chandra", alive: false, capabilities: ["parse"] },
    ],
  });
}
