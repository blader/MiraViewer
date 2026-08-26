export function formatDate(dateString: string | null): string {
  if (!dateString) return 'Unknown Date';
  const separator = dateString.indexOf('#');
  const value = separator < 0 ? dateString : dateString.slice(0, separator);
  const examinationUid = separator < 0 ? '' : dateString.slice(separator + 1);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown Date';

  let formatted = date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  if (date.getHours() !== 0 || date.getMinutes() !== 0 || date.getSeconds() !== 0) {
    formatted += ` · ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (examinationUid) {
    let fingerprint = 0;
    for (let index = 0; index < examinationUid.length; index++) {
      fingerprint = (Math.imul(fingerprint, 31) + examinationUid.charCodeAt(index)) >>> 0;
    }
    formatted += ` · exam ${fingerprint.toString(36).slice(-4)}`;
  }
  return formatted;
}

/**
 * Format rotation degrees compactly (e.g. "0", "90", "0.25", "12.5").
 */
export function formatRotation(degrees: number): string {
  return degrees
    .toFixed(2)
    .replace(/\.00$/, '')
    .replace(/(\.[0-9])0$/, '$1');
}
