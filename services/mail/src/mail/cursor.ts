import { ValidationError } from '@onebox/errors';

// lastUid breaks ties between conversations in the same second (IMAP dates have 1s precision),
// so the list order matches the order mail is fetched in.
export interface ThreadCursor {
  lastMessageAt: Date;
  lastUid: number;
  id: string;
}

export const encodeCursor = ({ lastMessageAt, lastUid, id }: ThreadCursor) =>
  Buffer.from(JSON.stringify([lastMessageAt.toISOString(), lastUid, id])).toString('base64url');

export function decodeCursor(cursor: string): ThreadCursor {
  try {
    const [iso, lastUid, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [
      string,
      number,
      string,
    ];
    const lastMessageAt = new Date(iso);
    if (
      typeof id !== 'string' ||
      !Number.isInteger(lastUid) ||
      Number.isNaN(lastMessageAt.getTime())
    ) {
      throw new Error('bad cursor');
    }
    return { lastMessageAt, lastUid, id };
  } catch {
    throw new ValidationError('Invalid cursor', { code: 'INVALID_CURSOR' });
  }
}
