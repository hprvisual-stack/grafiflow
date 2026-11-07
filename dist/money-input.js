const moneyFormatter = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function parseMoneyInputValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? '').trim();
  if (!raw) return 0;

  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw;
  const parsed = Number(normalized.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatMoneyInputValue(value) {
  return moneyFormatter.format(parseMoneyInputValue(value));
}

function digitsToCents(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return 0;
  const cents = Number(digits);
  return Number.isSafeInteger(cents) ? cents : Number.MAX_SAFE_INTEGER;
}

function formatCents(cents) {
  return moneyFormatter.format(cents / 100);
}

export function nextMoneyInputValue(currentValue, {
  inputType,
  data = '',
  paste = '',
  replaceSelection = false,
} = {}) {
  let cents = replaceSelection ? 0 : digitsToCents(currentValue);

  if (inputType === 'insertFromPaste') {
    const pastedValue = parseMoneyInputValue(paste || data);
    cents = Math.min(Number.MAX_SAFE_INTEGER, Math.round(Math.max(0, pastedValue) * 100));
    return formatCents(cents);
  }

  if (inputType === 'insertText' || inputType === 'insertReplacementText') {
    const rawData = String(data ?? '');
    if (!rawData) return null;
    const digits = rawData.replace(/\D/g, '');
    for (const digit of digits) {
      cents = Math.min(Number.MAX_SAFE_INTEGER, cents * 10 + Number(digit));
    }
    return formatCents(cents);
  }

  if (inputType === 'deleteContentBackward') {
    cents = replaceSelection ? 0 : Math.floor(cents / 10);
    return formatCents(cents);
  }

  if (inputType === 'deleteContentForward') return formatCents(replaceSelection ? 0 : cents);
  return null;
}
