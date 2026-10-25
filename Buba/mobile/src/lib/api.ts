import type { AppConfig } from './supabase';

export interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  sellerId: string;
  seller: string;
}

export interface CheckoutSession {
  url: string;
  sessionId: string;
}

export interface SellerStatus {
  connected: boolean;
  country: string | null;
}

export async function getAppConfig(apiBaseUrl: string): Promise<AppConfig> {
  const response = await fetch(`${apiBaseUrl}/api/config`);
  const result = await response.json();
  if (!response.ok) {
    const missing = Array.isArray(result.missing) ? result.missing.join(', ') : '';
    throw new Error(
      `${result.error || 'Unable to load app configuration.'}${missing ? ` Missing: ${missing}.` : ''}`,
    );
  }
  return result as AppConfig;
}

export async function apiRequest<T>(
  apiBaseUrl: string,
  path: string,
  options: RequestInit = {},
  accessToken?: string,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (options.body) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${apiBaseUrl}${path}`, { ...options, headers });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || 'The request could not be completed.');
  }
  return result as T;
}
