export interface Plan {
  id: string;
  name: string;
  images: number; // -1 = unlimited
  models: number;
  training: boolean;
  price: number; // cents
  recurring?: "month";
  description: string;
  features: string[];
}

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    images: 25,
    models: 0,
    training: false,
    price: 0,
    description: "Try it out",
    features: [
      "25 labeled images",
      "COCO + YOLO export",
      "Community support",
    ],
  },
  {
    id: "starter",
    name: "Starter",
    images: 200,
    models: 1,
    training: false,
    price: 1500,
    description: "For side projects",
    features: [
      "200 labeled images",
      "1 trained model",
      "All export formats",
      "Email support",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    images: 500,
    models: 1,
    training: true,
    price: 3900,
    description: "For professionals",
    features: [
      "500 labeled images",
      "1 trained model",
      "Cloud GPU training",
      "Priority support",
    ],
  },
  {
    id: "team",
    name: "Team",
    images: -1,
    models: 5,
    training: true,
    price: 7900,
    recurring: "month",
    description: "For teams shipping fast",
    features: [
      "Unlimited images",
      "5 trained models / month",
      "Cloud GPU training",
      "Dedicated support",
      "API access",
    ],
  },
];

export function getPlan(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
