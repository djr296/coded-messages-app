(function () {
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const TYPES = new Set([...IMAGE_TYPES, 'application/pdf', 'text/plain']);
  const MAX_BYTES = 512 * 1024;

  function safeDataUrl(value, expectedType, imageOnly = false) {
    if (typeof value !== 'string' || value.length > 750000) return '';
    const match = /^data:([a-z]+\/[a-z]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
    if (!match || !match[2] || match[2].length % 4 !== 0) return '';
    const [, mimeType, encoded] = match;
    if (!(imageOnly ? IMAGE_TYPES : TYPES).has(mimeType)) return '';
    if (expectedType && mimeType !== expectedType) return '';
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    if (encoded.length * 3 / 4 - padding > MAX_BYTES) return '';
    return value;
  }

  function validateAttachment(attachment) {
    if (!attachment) return null;
    const data = safeDataUrl(attachment.data, attachment.type);
    if (!data) throw new Error('Attach a supported image, PDF, or text file up to 512 KB.');
    const name = String(attachment.name || 'attachment').replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 180);
    return { data, type: attachment.type, name };
  }

  const api = Object.freeze({ safeDataUrl, validateAttachment, MAX_BYTES });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.codedContentSecurity = api;
})();
