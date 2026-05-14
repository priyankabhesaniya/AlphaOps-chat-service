/**
 * Chat attachment rules — keep in sync with:
 * - frontend/src/pages/CHAT/chatAttachmentRules.js
 * - upload-service/utils/chatAttachmentRules.js
 */
const CHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Lowercase extensions (includes common Office types so Excel/Word uploads work). */
const CHAT_ATTACHMENT_ALLOWED_EXTENSIONS = new Set([
  "txt",
  "csv",
  "pdf",
  "gif",
  "mp3",
  "mp4",
  "mkv",
  "jpg",
  "jpeg",
  "png",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "docx",
]);

function getExtensionFromFileName(fileName) {
  const base = String(fileName || "").trim();
  const i = base.lastIndexOf(".");
  if (i <= 0 || i >= base.length - 1) return "";
  return base.slice(i + 1).toLowerCase();
}

/** True when destPath targets org/.../chat/attachment (case-insensitive, slashes normalized). */
function isChatAttachmentDestPath(destPath) {
  const p = String(destPath || "")
    .trim()
    .replace(/\\/g, "/")
    .toLowerCase();
  if (!p) return false;
  return /(^|\/)([^/]+\/)?chat\/attachment(\/|$)/.test(p);
}

/**
 * Validates file-message metadata from the socket payload.
 * @param {{ file_name?: string, file_size_bytes?: number|string, file_reference_id?: string }} input
 */
function validateChatAttachmentPayload(input) {
  const file_reference_id = input?.file_reference_id;
  const file_name = input?.file_name;
  const file_size_bytes = input?.file_size_bytes;

  if (!file_reference_id || !String(file_reference_id).trim()) {
    return { ok: false, error: "file_reference_id is required for file messages" };
  }
  if (!file_name || !String(file_name).trim()) {
    return { ok: false, error: "file_name is required for file messages" };
  }
  const ext = getExtensionFromFileName(file_name);
  if (!ext || !CHAT_ATTACHMENT_ALLOWED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      error:
        "File type not allowed. Allowed: txt, xls, xlsx, csv, pdf, ppt, pptx, docx, jpg, png, jpeg, gif, mp4, mkv, mp3",
    };
  }
  const n = Number(file_size_bytes);
  if (!Number.isFinite(n) || n < 1) {
    return { ok: false, error: "file_size_bytes is required for file messages" };
  }
  if (n > CHAT_ATTACHMENT_MAX_BYTES) {
    return { ok: false, error: "File exceeds 10 MB limit" };
  }
  return { ok: true };
}

module.exports = {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_ALLOWED_EXTENSIONS,
  getExtensionFromFileName,
  isChatAttachmentDestPath,
  validateChatAttachmentPayload,
};
