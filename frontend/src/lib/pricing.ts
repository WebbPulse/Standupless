/**
 * The plans Standupless sells and what each one holds, in one place so the
 * pricing page, its tests and the prerendered HTML read the same numbers. The
 * limits mirror `backend/app/common/plan_limits.py`, which enforces them.
 */

/** A billing interval a paid plan can be bought on. */
export type BillingInterval = 'annual' | 'monthly';

/** One plan on the pricing page. */
export interface PricedPlan {
  id: 'free' | 'standard' | 'business';
  name: string;
  /** One sentence on who the plan is for. */
  summary: string;
  /** US dollars per seat per month, by billing interval. */
  price: Record<BillingInterval, number>;
  /** What the plan includes, in the order the card lists it. */
  features: string[];
  /** The plan the card lists on top of, named in the features heading. */
  includesPlan?: string;
  /** Set on the plan the page draws attention to. */
  highlighted?: boolean;
}

/** Every plan, cheapest first. */
export const PLANS: PricedPlan[] = [
  {
    id: 'free',
    name: 'Free',
    summary: 'For a small team trying Standupless on real work.',
    price: { annual: 0, monthly: 0 },
    features: [
      'Up to 10 members',
      '2 teams',
      'Unlimited issues',
      'Cycles, projects and the roadmap',
      'GitHub App with two way issue sync',
      'REST API, MCP server and CLI',
      '2 webhooks and 5 API keys',
      '2 GB of attachment storage',
    ],
  },
  {
    id: 'standard',
    name: 'Standard',
    summary: 'For teams that run their planning in Standupless.',
    price: { annual: 6, monthly: 8 },
    includesPlan: 'Free',
    highlighted: true,
    features: [
      'Up to 1,000 members',
      '10 teams',
      'Guests, up to 5 per paid seat',
      '20 webhooks and 25 API keys',
      '100 GB of attachment storage',
    ],
  },
  {
    id: 'business',
    name: 'Business',
    summary: 'For organizations with many teams under one workspace.',
    price: { annual: 10, monthly: 12 },
    includesPlan: 'Standard',
    features: [
      'Up to 2,500 members',
      '250 teams',
      '50 webhooks and 100 API keys',
      '250 GB of attachment storage',
    ],
  },
];

/** A whole dollar amount as the page prints it, such as `$6`. */
export const formatPrice = (dollars: number): string => `$${String(dollars)}`;
