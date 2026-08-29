/**
 * @module billingAPI
 * Billing client for the single Vercel function /api/billing.
 */
import type { BillingStatus, SubscriptionTier } from '../types/billing';
import { buildAuthHeadersAsync } from './authToken';

const API_BASE = '/api/billing';

async function readError(res: Response, fallback: string): Promise<never> {
  const payload = await res.json().catch(() => ({ error: fallback }));
  throw new Error(payload?.error || `${fallback} (${res.status})`);
}

export async function getSubscriptionStatus(): Promise<BillingStatus> {
  const headers = await buildAuthHeadersAsync();
  const res = await fetch(`${API_BASE}?action=status`, { method: 'GET', headers });
  if (!res.ok) return readError(res, 'Errore stato abbonamento');
  return res.json();
}

export async function createCheckoutSession(tier: SubscriptionTier): Promise<string> {
  if (tier === 'free') throw new Error('Il piano Free non richiede checkout');
  const headers = await buildAuthHeadersAsync();
  const res = await fetch(`${API_BASE}?action=checkout`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tier }),
  });
  if (!res.ok) return readError(res, 'Errore checkout');
  const data = await res.json();
  if (!data?.url) throw new Error('Stripe non ha restituito un URL checkout');
  return data.url;
}

export async function getPortalUrl(): Promise<string> {
  const headers = await buildAuthHeadersAsync();
  const res = await fetch(`${API_BASE}?action=portal`, { method: 'POST', headers });
  if (!res.ok) return readError(res, 'Errore portale Stripe');
  const data = await res.json();
  if (!data?.url) throw new Error('Stripe non ha restituito un URL portale');
  return data.url;
}
