/** A date a week old or older; one outside the current year shows its year. */
const calendarDate = (unixSeconds: number, nowSeconds: number) => {
  const date = new Date(unixSeconds * 1000);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date(nowSeconds * 1000).getFullYear() && {
      year: "numeric",
    }),
  });
};

/** Buzz desktop's thread-summary recency ladder (dateFormatters.ts), plus the
 * year on a date outside the current year. */
export function relativeTimestamp(
  unixSeconds: number,
  nowSeconds = Date.now() / 1000,
) {
  const age = Math.max(0, nowSeconds - unixSeconds);
  const ago = (value: number, unit: string) =>
    `${value} ${unit}${value === 1 ? "" : "s"} ago`;
  if (age < 60) return "just now";
  if (age < 3600) return ago(Math.floor(age / 60), "minute");
  if (age < 86400) return ago(Math.floor(age / 3600), "hour");
  if (age < 604800) return ago(Math.floor(age / 86400), "day");
  return `on ${calendarDate(unixSeconds, nowSeconds)}`;
}

/** The same ladder abbreviated for cards too narrow for it, such as the
 * sidebar's activity previews: "now", "5m", "3h", "2d", then the date. */
export function shortRelativeTimestamp(
  unixSeconds: number,
  nowSeconds = Date.now() / 1000,
) {
  const age = Math.max(0, nowSeconds - unixSeconds);
  if (age < 60) return "now";
  if (age < 3600) return `${Math.floor(age / 60)}m`;
  if (age < 86400) return `${Math.floor(age / 3600)}h`;
  if (age < 604800) return `${Math.floor(age / 86400)}d`;
  return calendarDate(unixSeconds, nowSeconds);
}
