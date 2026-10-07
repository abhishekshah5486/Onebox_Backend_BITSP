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
export const PRESETS: Record<'GMAIL' | 'OUTLOOK', ProviderPreset> = {
  GMAIL: {
    imap: { host: 'imap.gmail.com', port: 993, tls: true },
    smtp: { host: 'smtp.gmail.com', port: 465, tls: true },
  },
  OUTLOOK: {
    imap: { host: 'outlook.office365.com', port: 993, tls: true },
    smtp: { host: 'smtp.office365.com', port: 587, tls: false },
  },
};
