/**
 * Billing types. Client tiers intentionally map the production DB plans as:
 * free -> free, base (€9.90) -> pro, pro (€24.90) -> unlimited.
 */
export type SubscriptionTier = 'free' | 'pro' | 'unlimited';

export type SubscriptionStatus =
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'trialing'
  | 'incomplete';

export interface UsageStats {
  messagesUsed: number;
  messagesLimit: number | null;
  limitPeriod: 'day' | 'month';
  resetAt: string | null;
  costBreakdown: CostBreakdown[];
}

export interface CostBreakdown {
  provider: string;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface BillingStatus {
  tier: SubscriptionTier;
  status: SubscriptionStatus | 'none';
  usage: UsageStats;
}

export interface PricingTier {
  id: SubscriptionTier;
  name: string;
  priceMonthly: number;
  messagesLimit: number | null;
  limitPeriod: 'day' | 'month';
  /** Human-readable quota description when limits are multi-dimensional. */
  usageLabel?: string;
  features: string[];
  highlighted?: boolean;
}

export const PRICING_TIERS_DISPLAY: PricingTier[] = [
  {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    messagesLimit: null,
    limitPeriod: 'month',
    usageLabel: '5 conversazioni/mese · 20 messaggi per conversazione',
    features: [
      '2 agenti AI',
      '5 conversazioni al mese',
      '20 messaggi per conversazione',
      'Cronologia chat',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 9.90,
    messagesLimit: null,
    limitPeriod: 'month',
    usageLabel: '50 conversazioni/mese · 100 messaggi per conversazione',
    highlighted: true,
    features: [
      '3 agenti AI',
      '50 conversazioni al mese',
      '100 messaggi per conversazione',
      'Voce abilitata',
    ],
  },
  {
    id: 'unlimited',
    name: 'Unlimited',
    priceMonthly: 24.90,
    messagesLimit: null,
    limitPeriod: 'month',
    usageLabel: 'Conversazioni e messaggi illimitati',
    features: [
      '3 agenti AI',
      'Conversazioni illimitate',
      'Messaggi illimitati',
      'Voce abilitata',
    ],
  },
];

export interface BillingContextValue {
  tier: SubscriptionTier;
  status: BillingStatus | null;
  isLoading: boolean;
  error: string | null;
  refreshStatus: () => Promise<void>;
  openCheckout: (tier: SubscriptionTier) => Promise<void>;
  openPortal: () => Promise<void>;
  isAtLimit: boolean;
}
