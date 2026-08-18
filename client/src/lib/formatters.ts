export const toNumber = (value: number | string | null | undefined): number => Number(value ?? 0);

export const formatNumber = (value: number | string | null | undefined): string =>
  new Intl.NumberFormat().format(toNumber(value));

export const formatCurrency = (
  value: number | string | null | undefined,
  fractionDigits = 0,
): string =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(toNumber(value));

export const formatPercent = (value: number | string | null | undefined, digits = 0): string =>
  `${toNumber(value).toFixed(digits)}%`;

export const formatBytes = (value: number | string | null | undefined): string => {
  const bytes = toNumber(value);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 'Not collected';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
};

export const daysAgo = (days: number): string => {
  const date = new Date(Date.now() - days * 86400000);
  return date.toISOString().slice(0, 10);
};

export const today = (): string => new Date().toISOString().slice(0, 10);
