export const ALLOWED_EMAIL_DOMAINS = [
  'periniprojetos.com.br',
  'livingfinds.com.br',
];

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function getEmailDomain(email) {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  return at > 0 ? normalized.slice(at + 1) : '';
}

export function isAllowedEmail(email) {
  return ALLOWED_EMAIL_DOMAINS.includes(getEmailDomain(email));
}

export const EMAIL_DOMAIN_ERROR =
  'Acesso restrito a e-mails @periniprojetos.com.br e @livingfinds.com.br.';
