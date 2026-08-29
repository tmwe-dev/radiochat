/** Billing plan cards. */
import { PRICING_TIERS_DISPLAY, type SubscriptionTier } from '../../types/billing';
import { useBillingContext } from '../../context/BillingContext';

interface PricingCardsProps {
  onSelect?: (tier: SubscriptionTier) => void;
  compact?: boolean;
}

export function PricingCards({ onSelect, compact }: PricingCardsProps) {
  const { tier: currentTier, openCheckout, isLoading } = useBillingContext();

  const handleSelect = async (tier: SubscriptionTier) => {
    if (onSelect) {
      onSelect(tier);
      return;
    }
    if (tier === 'free' || tier === currentTier) return;
    try {
      await openCheckout(tier);
    } catch {
      // BillingContext exposes the user-facing error.
    }
  };

  return (
    <div className={`pricing-cards ${compact ? 'pricing-cards--compact' : ''}`}>
      {PRICING_TIERS_DISPLAY.map((plan) => {
        const isCurrent = plan.id === currentTier;
        const isDowngrade =
          (currentTier === 'unlimited' && plan.id !== 'unlimited') ||
          (currentTier === 'pro' && plan.id === 'free');

        return (
          <div
            key={plan.id}
            className={`pricing-card ${plan.highlighted ? 'pricing-card--highlighted' : ''} ${isCurrent ? 'pricing-card--current' : ''}`}
          >
            {plan.highlighted && <div className="pricing-card__badge">Consigliato</div>}
            {isCurrent && (
              <div className="pricing-card__badge pricing-card__badge--current">Piano attuale</div>
            )}

            <h3 className="pricing-card__name">{plan.name}</h3>
            <div className="pricing-card__price">
              <span className="pricing-card__amount">
                {plan.priceMonthly === 0 ? 'Gratis' : `€${plan.priceMonthly.toFixed(2)}`}
              </span>
              {plan.priceMonthly > 0 && <span className="pricing-card__period">al mese</span>}
            </div>

            <div className="pricing-card__limit">
              {plan.usageLabel || (plan.messagesLimit === null
                ? 'Messaggi illimitati'
                : `${plan.messagesLimit} messaggi/${plan.limitPeriod === 'day' ? 'giorno' : 'mese'}`)}
            </div>

            <ul className="pricing-card__features">
              {plan.features.map((feature, index) => <li key={index}>{feature}</li>)}
            </ul>

            <button
              className={`pricing-card__cta ${plan.highlighted ? 'pricing-card__cta--primary' : ''}`}
              onClick={() => handleSelect(plan.id)}
              disabled={isCurrent || isLoading || isDowngrade}
            >
              {isCurrent
                ? 'Piano attuale'
                : isDowngrade
                  ? 'Gestisci abbonamento'
                  : plan.priceMonthly === 0
                    ? 'Inizia gratis'
                    : `Passa a ${plan.name}`}
            </button>
          </div>
        );
      })}
    </div>
  );
}
