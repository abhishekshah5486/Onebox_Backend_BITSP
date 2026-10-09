import sanitizeHtml from 'sanitize-html';

const UNSAFE_CSS = /url\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding|@import/i;

// Keeps inline styles (email layouts depend on them) but drops any declaration that can
// load remote content or execute code.
function cleanStyle(style: string): string {
  return style
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration && !UNSAFE_CSS.test(declaration))
    .join('; ');
}

const LAYOUT_ATTRIBUTES = [
  'align',
  'valign',
  'width',
  'height',
  'bgcolor',
  'border',
  'cellpadding',
  'cellspacing',
  'colspan',
  'rowspan',
  'dir',
];

export interface SanitizedHtml {
  html: string;
  hasRemoteImages: boolean;
}

export function sanitizeEmailHtml(dirty: string): SanitizedHtml {
  let hasRemoteImages = false;
  const html = sanitizeHtml(dirty, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img',
      'center',
      'font',
      'span',
      'u',
      's',
      'hr',
    ]),
    allowedAttributes: {
      '*': ['style', 'title', 'class', ...LAYOUT_ATTRIBUTES],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      font: ['color', 'face', 'size'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
    allowProtocolRelative: false,
    parseStyleAttributes: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
      '*': (tagName, attribs) =>
        attribs.style
          ? { tagName, attribs: { ...attribs, style: cleanStyle(attribs.style) } }
          : { tagName, attribs },
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === 'img' && /^https?:/i.test(frame.attribs.src ?? '')) hasRemoteImages = true;
      return false;
    },
  });
  return { html, hasRemoteImages };
}
