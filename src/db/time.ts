// Forge SQL's MySQL engine expects DATETIME literals as 'YYYY-MM-DD HH:MM:SS'
// (no 'T'/'Z'). We always write in UTC and treat every stored timestamp as
// UTC on the way back out, so round-tripping through these two helpers is
// lossless for our purposes (millisecond precision is not needed anywhere
// in this app — debounce comparisons use whole seconds).

export function toSqlDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function nowSqlDateTime(): string {
  return toSqlDateTime(new Date());
}

export function sqlDateTimeToIso(value: string): string {
  return `${value.replace(' ', 'T')}.000Z`;
}
