/** Central policy for media analysis. Text, replies and forwarded text do not
 * need a media grant; binary attachment analysis does. */
export function canAnalyzeAttachments({ userId, state, env = process.env } = {}) {
  if (!userId) return false;
  if (state?.userSettings?.[userId]?.attachmentProcessingEnabled === true) return true;
  const allowed = String(env.HELIUM_ATTACHMENT_ALLOWLIST || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  return allowed.includes(String(userId));
}

export function describeAttachmentPolicy() {
  return Object.freeze({ default: 'deny', grantField: 'attachmentProcessingEnabled', grantsAreRevocable: true });
}
