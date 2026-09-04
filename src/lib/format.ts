const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

export function fa(str: number | string): string {
  return String(str).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}

/** 24-hour clock with Persian digits, e.g. «۱۷:۴۵» */
export function clock(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return fa(`${h}:${m}`);
}

export function formatDay(ts: number): string {
  return new Intl.DateTimeFormat("fa-IR", { day: "numeric", month: "long" }).format(ts);
}

/** Relative, warm Persian label for the lobby. */
export function relative(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return "الان";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${fa(mins)} دقیقه`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${fa(hours)} ساعت`;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = startOfToday.getTime() - 86_400_000;
  if (ts >= startOfYesterday) return "دیروز";
  // Older than yesterday: a bare clock time would be ambiguous (which day?), so
  // show the calendar day instead.
  return formatDay(ts);
}

export function secondsToClock(s: number): string {
  const mm = Math.floor(s / 60)
    .toString()
    .padStart(2, "0");
  const ss = Math.floor(s % 60)
    .toString()
    .padStart(2, "0");
  return fa(`${mm}:${ss}`);
}

export function initials(name: string): string {
  const tokens = name.trim().split(/\s+/).slice(0, 2);
  return tokens.map((t) => Array.from(t)[0] ?? "").join(" ");
}

/** Read out a message excerpt under a conversation row. */
export function preview(body: string): string {
  return body.replace(/\n+/g, " ").trim().slice(0, 60);
}