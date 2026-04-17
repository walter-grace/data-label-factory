import { NextResponse } from "next/server";

export async function GET() {
  const hasOpenRouter = !!process.env.LLM_API_KEY;
  return NextResponse.json({
    providers: [
      { name: "openrouter", alive: hasOpenRouter, capabilities: ["filter", "label", "verify"] },
      { name: "falcon", alive: false, capabilities: ["filter", "label", "verify"] },
      { name: "gemma", alive: false, capabilities: ["filter", "label"] },
      { name: "liteparse", alive: false, capabilities: ["parse"] },
      { name: "chandra", alive: false, capabilities: ["parse"] },
    ],
  });
}
