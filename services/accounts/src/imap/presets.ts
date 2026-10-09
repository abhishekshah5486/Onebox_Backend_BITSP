export interface ServerSettings {
  host: string;
  port: number;
  tls: boolean;
}

export interface ProviderPreset {
  imap: ServerSettings;
  smtp: ServerSettings;
}

// tls=false on SMTP means STARTTLS on the submission port.
export const PRESET_PROVIDERS = ['GMAIL', 'OUTLOOK', 'ICLOUD', 'YAHOO'] as const;
export type PresetProvider = (typeof PRESET_PROVIDERS)[number];

// Outlook also covers Hotmail and Live addresses (same Microsoft servers).
export const PRESETS: Record<PresetProvider, ProviderPreset> = {
  GMAIL: {
    imap: { host: 'imap.gmail.com', port: 993, tls: true },
    smtp: { host: 'smtp.gmail.com', port: 465, tls: true },
  },
  OUTLOOK: {
    imap: { host: 'outlook.office365.com', port: 993, tls: true },
    smtp: { host: 'smtp.office365.com', port: 587, tls: false },
  },
  ICLOUD: {
    imap: { host: 'imap.mail.me.com', port: 993, tls: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, tls: false },
  },
  YAHOO: {
    imap: { host: 'imap.mail.yahoo.com', port: 993, tls: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, tls: true },
  },
};
