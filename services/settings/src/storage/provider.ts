import type { StorageProviderId } from '@onebox/contracts';

export type { StorageProviderId };

export interface AccessToken {
  token: string;
  expiresIn: number;
  // Set when the provider issues a new refresh token with each refresh (e.g. Microsoft).
  refreshToken?: string;
}

// One cloud storage service (Google Drive, OneDrive, Dropbox) behind OAuth.
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
export const CALLBACK_SLUGS: Record<StorageProviderId, string> = {
  GOOGLE_DRIVE: 'google',
  ONEDRIVE: 'microsoft',
  DROPBOX: 'dropbox',
};

export const PROVIDER_NAMES: Record<StorageProviderId, string> = {
  GOOGLE_DRIVE: 'Google Drive',
  ONEDRIVE: 'OneDrive',
  DROPBOX: 'Dropbox',
};
