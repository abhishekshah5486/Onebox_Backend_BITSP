const PREFIX = /^\s*(?:(?:re|fw|fwd|aw|wg|sv|vs|antw)\s*(?:\[\d+\])?\s*:|\[[^\]]{1,40}\])\s*/i;

export function normalizeSubject(subject: string): string {
  let current = subject;
  for (let previous = ''; previous !== current;) {
    previous = current;
    current = current.replace(PREFIX, '');
  }
  return current.replace(/\s+/g, ' ').trim().toLowerCase();
}

export const isReplySubject = (subject: string) =>
  /^\s*(?:re|fw|fwd|aw|sv|antw)\s*(?:\[\d+\])?\s*:/i.test(subject);
