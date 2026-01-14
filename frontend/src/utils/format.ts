export function formatDate(dateString: string | null): string {
  if (!dateString) return 'Unknown Date';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
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
