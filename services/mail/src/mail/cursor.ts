import { ValidationError } from '@onebox/errors';

export interface ThreadCursor {
  lastMessageAt: Date;
  id: string;
}

export const encodeCursor = ({ lastMessageAt, id }: ThreadCursor) =>
  Buffer.from(JSON.stringify([lastMessageAt.toISOString(), id])).toString('base64url');

export function decodeCursor(cursor: string): ThreadCursor {
  try {
    const [iso, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [
      string,
      string,
    ];
    const lastMessageAt = new Date(iso);
    if (typeof id !== 'string' || Number.isNaN(lastMessageAt.getTime()))
      throw new Error('bad cursor');
    return { lastMessageAt, id };
  } catch {
    throw new ValidationError('Invalid cursor', { code: 'INVALID_CURSOR' });
  }
}
