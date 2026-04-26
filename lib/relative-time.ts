// Format a timestamp as "15 minutes ago", "2 days ago", etc.
// Returns null when ts is 0 / missing — caller decides what to render.

export function formatRelativeTime(
  ts: number,
  now: number = Date.now(),
): string | null {
  if (!ts || ts <= 0) return null;
  const diffSec = Math.max(0, Math.round((now - ts) / 1000));
  if (diffSec < 45) return "just now";
  if (diffSec < 90) return "1 minute ago";
  const minutes = Math.round(diffSec / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  if (minutes < 90) return "1 hour ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  if (hours < 36) return "1 day ago";
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} days ago`;
  if (days < 11) return "1 week ago";
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks} weeks ago`;
  if (days < 45) return "1 month ago";
  const months = Math.round(days / 30);
  if (months < 12) return `${months} months ago`;
  if (days < 545) return "1 year ago";
  const years = Math.round(days / 365);
  return `${years} years ago`;
}
