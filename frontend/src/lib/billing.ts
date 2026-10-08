/**
 * How billing reads in the interface: plan names, per seat prices, byte sizes
 * and the sentence a Checkout return leaves behind. The server owns every
 * number that gates anything; the prices here are display copy that matches
 * the Stripe prices the owner configures.
 */

import type { BillingInterval, PaidPlan } from '../types/Api';

/** A paid plan as the plan picker offers it. */
export interface PlanOffer {
  plan: PaidPlan;
  name: string;
  summary: string;
  /** The per seat price in whole US dollars, per month, by billing interval. */
  monthlyPrice: Record<BillingInterval, number>;
}

/** The paid plans, cheapest first. */
export const PLAN_OFFERS: readonly PlanOffer[] = [
  {
    plan: 'standard',
    name: 'Standard',
    summary:
      'More teams, guests, triage, a public roadmap and 100 GB of storage.',
    monthlyPrice: { year: 6, month: 8 },
  },
  {
    plan: 'business',
    name: 'Business',
    summary:
      'Private teams, insights, issue SLAs, an audit log and 250 GB of storage.',
    monthlyPrice: { year: 10, month: 12 },
  },
];

/** A plan gated feature a settings section explains before the server refuses it. */
export type GatedFeature = 'triage' | 'issue_slas';

/** The plans the client knows the features of. */
const KNOWN_PLANS: readonly string[] = ['free', 'standard', 'business'];

/** The plans each gated feature comes with, mirroring the server's plan features. */
const FEATURE_PLANS: Record<GatedFeature, readonly string[]> = {
  triage: ['standard', 'business'],
  issue_slas: ['business'],
};

/** The cheapest plan each gated feature comes with, as it reads. */
export const FEATURE_PLAN_NAMES: Record<GatedFeature, string> = {
  triage: 'Standard',
  issue_slas: 'Business',
};

/**
 * Whether a workspace on `plan` has `feature`. An unknown plan reads as
 * included, so the server's refusal stays the one that counts.
 */
export const planIncludes = (
  plan: string | undefined,
  feature: GatedFeature
): boolean => {
  if (plan === undefined || !KNOWN_PLANS.includes(plan)) return true;
  return FEATURE_PLANS[feature].includes(plan);
};

/** The workspace billing settings page, where a plan is upgraded. */
export const billingSettingsPath = (slug: string): string =>
  `/w/${slug}/settings/billing`;

/** How a plan id reads, falling back to the id with its first letter raised. */
export const planName = (plan: string): string =>
  plan === '' ? 'Free' : plan.charAt(0).toUpperCase() + plan.slice(1);

/** The price line for a plan offer at an interval. */
export const priceLine = (
  offer: PlanOffer,
  interval: BillingInterval
): string =>
  interval === 'year'
    ? `$${offer.monthlyPrice.year} per seat per month, billed annually`
    : `$${offer.monthlyPrice.month} per seat per month, billed monthly`;

const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'] as const;

/** A byte count in binary units, to one decimal place above a kilobyte. */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 bytes';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${value} ${value === 1 ? 'byte' : 'bytes'}`;
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} ${UNITS[unit]}`;
};

/** The share of a limit in use, clamped to 0 through 100. */
export const usagePercent = (used: number, limit: number): number => {
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
};

/** The sentence a return from Checkout leaves, or null for any other visit. */
export const checkoutOutcome = (
  value: string | null
): { tone: 'success' | 'info'; message: string } | null => {
  if (value === 'success') {
    return {
      tone: 'success',
      message:
        'Thanks for upgrading. The new plan shows here as soon as Stripe confirms the payment.',
    };
  }
  if (value === 'cancelled') {
    return {
      tone: 'info',
      message: 'Checkout was cancelled. Nothing was charged.',
    };
  }
  return null;
};

/** How a subscription status reads, or null when there is none to show. */
export const subscriptionStatusLabel = (
  status: string | null
): string | null => {
  switch (status) {
    case null:
    case '':
      return null;
    case 'active':
      return 'Active';
    case 'trialing':
      return 'Trial';
    case 'past_due':
      return 'Payment past due';
    case 'unpaid':
      return 'Unpaid';
    case 'canceled':
      return 'Cancelled';
    case 'incomplete':
    case 'incomplete_expired':
      return 'Payment incomplete';
    default:
      return status.replace(/_/g, ' ');
  }
};

/** How a limited resource reads in the plan's limit list. */
export const RESOURCE_LABELS: Record<string, string> = {
  teams: 'Teams',
  members: 'Members',
  invites: 'Pending invites',
  webhooks: 'Webhooks',
  api_keys: 'API keys',
};

/** How a plan feature reads, matching the server's own feature names. */
export const FEATURE_LABELS: Record<string, string> = {
  guests: 'Guests',
  triage: 'Triage',
  public_roadmap: 'Public roadmap',
  private_teams: 'Private teams',
  insights: 'Insights',
  issue_slas: 'Issue SLAs',
  audit_log: 'Audit log',
  auth_policy: 'Authentication policy',
};

/** Sends the browser to a hosted Stripe page. */
export const sendBrowserTo = (url: string): void => {
  globalThis.location.assign(url);
};
