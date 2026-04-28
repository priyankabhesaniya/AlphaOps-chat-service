function sanitizeRichText(input) {
  if (input === null || input === undefined) return "";

  let html = String(input);

  // Strip high-risk blocks entirely.
  html = html.replace(
    /<\s*(script|style|iframe|object|embed|link|meta|base|form)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    ""
  );
  html = html.replace(
    /<\s*\/?\s*(script|style|iframe|object|embed|link|meta|base|form)[^>]*\/?\s*>/gi,
    ""
  );

  // Remove inline event handlers and style attributes.
  html = html.replace(/\s+on[a-zA-Z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "");
  html = html.replace(/\s+style\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "");

  // Neutralize javascript/data URI vectors in href/src.
  html = html.replace(/\s+(href|src)\s*=\s*("|\')\s*javascript:[\s\S]*?\2/gi, "");
  html = html.replace(/\s+(href|src)\s*=\s*("|\')\s*data:text\/html[\s\S]*?\2/gi, "");

  return html.trim();
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function toPlainText(input) {
  if (input === null || input === undefined) return "";

  const html = String(input);
  return decodeEntities(
    html
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/\s*(p|div|li|ul|ol|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = {
  sanitizeRichText,
  toPlainText,
};
