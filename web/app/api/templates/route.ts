import { NextResponse } from "next/server";

const TEMPLATES = [
  { name: "us-invoice", title: "US Invoice", fields: 12, description: "Standard US invoice — vendor, bill-to, line items, totals, dates, PO number.", category: "financial" },
  { name: "w2", title: "W-2 Tax Form", fields: 17, description: "IRS Form W-2 — employee info, wages, withholdings, employer EIN.", category: "tax" },
  { name: "1099-nec", title: "1099-NEC", fields: 13, description: "IRS Form 1099-NEC — nonemployee compensation, payer/recipient info.", category: "tax" },
  { name: "receipt", title: "Receipt", fields: 12, description: "Retail receipt — store, items, subtotal, tax, total, payment method.", category: "financial" },
  { name: "service-agreement", title: "Service Agreement", fields: 11, description: "Service contract — parties, scope, term, compensation, termination.", category: "legal" },
];

export async function GET() {
  return NextResponse.json({ templates: TEMPLATES, count: TEMPLATES.length });
}
