/** Conservative date interpretation for an explicitly targeted saved question. */
export function resolveDateAnswer(text: string, nowIso: string, timezone: string | null): unknown | undefined {
  const answer = text.trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(none|no deadline(?: for this one| needed)?|no due date|without (?:a )?deadline|fără termen|nincs határidő)$/.test(answer)) return null;
  const zoneSuffix = text.match(/\b([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/)?.[1];
  const zone = zoneSuffix ?? timezone;
  if (!zone) return undefined;
  let local: string;
  try { local = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowIso)); } catch { return undefined; }
  const expression = answer.replace(/\s+[a-z_]+\/[a-z_]+(?:\/[a-z_]+)?$/, '');
  let date = new Date(`${local}T00:00:00Z`);
  if (expression === 'today') { /* explicit today */ }
  else if (expression === 'tomorrow') date = new Date(date.getTime() + 86400000);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(expression)) {
    date = new Date(`${expression}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== expression) return undefined;
  } else {
    const day = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(expression);
    if (day < 0) return undefined;
    date = new Date(date.getTime() + ((day - date.getUTCDay() + 7) % 7) * 86400000);
  }
  return { kind: 'date', local_date: date.toISOString().slice(0, 10), timezone: zone };
}
