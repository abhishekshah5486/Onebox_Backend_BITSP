import type { STORAGE_PROVIDERS } from '../db/schema';

export type StorageProviderId = (typeof STORAGE_PROVIDERS)[number];

export interface AccessToken {
  token: string;
  expiresIn: number;
}

// One cloud storage service (Google Drive now; OneDrive and Dropbox later) behind OAuth.
export interface StorageProvider {
  authUrl(state: string): string;
  exchange(code: string): Promise<{
    email: string;
    refreshToken: string;
    scopes: string[];
    access?: AccessToken;
  }>;
  refresh(refreshToken: string): Promise<AccessToken>;
  revoke(refreshToken: string): Promise<void>;
}

// The provider no longer accepts the stored refresh token.
export class ExpiredGrantError extends Error {}

// The path segment in a provider's OAuth callback URL, e.g. /integrations/google/callback.
export const CALLBACK_SLUGS: Record<StorageProviderId, string> = { GOOGLE_DRIVE: 'google' };

export const PROVIDER_NAMES: Record<StorageProviderId, string> = { GOOGLE_DRIVE: 'Google Drive' };
