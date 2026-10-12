/**
 * "Every Monday at 9" → a schedule (F6 §4): a person describes an automation
 * in their own words, English or Turkish, and gets a configuration to look
 * over — never one that runs before they save it. Rules, not a model: what
 * they cannot read stays a manual automation with the words as its prompt.
 */

export type DraftKind = 'schedule' | 'monitor' | 'goal' | 'webhook' | 'email' | 'agent_event' | 'manual';
export type Cadence = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface AutomationDraft {
  kind: DraftKind;
  name: string;
  prompt: string;
  cadence: Cadence | null;
  weekdays: number[];
  monthDay: number | null;
  localTime: string | null;
  everyHours: number | null;
  monitorUrl: string | null;
  monitorCondition: string | null;
  goalUntil: string | null;
  /** What the parser understood, in words, for the person to check. */
  understood: string[];
}

const DAYS: [RegExp, number][] = [
  [/\b(mondays?|pazartesi(?:leri)?)\b/iu, 1],
  [/\b(tuesdays?|salı(?:ları)?)\b/iu, 2],
  [/\b(wednesdays?|çarşamba(?:ları)?)\b/iu, 3],
  [/\b(thursdays?|perşembe(?:leri)?)\b/iu, 4],
  [/\b(fridays?|cuma(?:ları)?)\b/iu, 5],
  [/\b(saturdays?|cumartesi(?:leri)?)\b/iu, 6],
  [/\b(sundays?|pazar(?:ları)?)(?!\s*(?:günü\s*)?(?:raporu|analizi))\b/iu, 7],
];

/** The local time a sentence names: "09:00", "9.30", "at 9", "9am", "6 pm", "saat 9", "18'de". */
export function timeOf(text: string): string | null {
  const clock = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(text);
  if (clock) return `${clock[1]!.padStart(2, '0')}:${clock[2]}`;
  const meridiem = /\b(1[0-2]|0?[1-9])\s*(am|pm|a\.m\.|p\.m\.)/i.exec(text);
  if (meridiem) {
    let hour = Number(meridiem[1]) % 12;
    if (/^p/i.test(meridiem[2]!)) hour += 12;
    return `${String(hour).padStart(2, '0')}:00`;
  }
  const at = /\b(?:at|saat)\s+([01]?\d|2[0-3])\b/i.exec(text) ?? /\b([01]?\d|2[0-3])\s*['’]?(?:de|da|te|ta)\b/iu.exec(text);
  if (at) return `${at[1]!.padStart(2, '0')}:00`;
  return null;
}

export function draftFrom(text: string, today = new Date()): AutomationDraft {
  const words = text.replace(/\s+/g, ' ').trim();
  const lower = words.toLocaleLowerCase('tr');
  const understood: string[] = [];
  const draft: AutomationDraft = {
    kind: 'manual',
    name: nameOf(words),
    prompt: words,
    cadence: null,
    weekdays: [],
    monthDay: null,
    localTime: timeOf(words),
    everyHours: null,
    monitorUrl: null,
    monitorCondition: null,
    goalUntil: null,
    understood,
  };

  // When: hourly, daily, weekdays, weekly on named days, monthly on a day.
  const everyHours = /\bevery\s+(\d{1,2})\s+hours?\b/i.exec(words) ?? /\bher\s+(\d{1,2})\s+saatte\b/iu.exec(words);
  const days = DAYS.filter(([re]) => re.test(words)).map(([, n]) => n);
  const monthDay = /\b(?:every month on the|on the)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(words) ?? /\bher\s+ayın\s+(\d{1,2})\s*['’]?\s*(?:i|ı|u|ü|si|sı|sü|su|inde|ında|ünde|unda)?\b/iu.exec(words);
  if (everyHours) {
    draft.cadence = 'hourly';
    draft.everyHours = Math.min(24, Math.max(1, Number(everyHours[1])));
  } else if (/\b(every hour|hourly)\b/i.test(words) || /\b(saatte bir|her saat)\b/iu.test(lower)) {
    draft.cadence = 'hourly';
    draft.everyHours = 1;
  } else if (monthDay || /\b(monthly|every month)\b/i.test(words) || /\bher ay\b/iu.test(lower)) {
    draft.cadence = 'monthly';
    draft.monthDay = monthDay ? Math.min(31, Math.max(1, Number(monthDay[1]))) : 1;
  } else if (/\b(weekdays|every weekday|on weekdays)\b/i.test(words) || /\bhafta\s*içi\b/iu.test(lower)) {
    draft.cadence = 'weekdays';
  } else if (days.length > 0) {
    draft.cadence = 'weekly';
    draft.weekdays = [...new Set(days)].sort();
  } else if (/\b(every day|daily|each day|every morning|every evening)\b/i.test(words) || /\b(her gün|her sabah|her akşam|günlük)\b/iu.test(lower)) {
    draft.cadence = 'daily';
  } else if (/\b(weekly|every week)\b/i.test(words) || /\bher hafta\b/iu.test(lower)) {
    draft.cadence = 'weekly';
    draft.weekdays = [1];
  }
  if (draft.cadence && !draft.localTime) {
    draft.localTime = draft.cadence === 'hourly' ? '00:00' : /\b(evening|akşam)/iu.test(lower) ? '18:00' : '09:00';
  }
  if (draft.cadence === 'hourly' && draft.localTime) draft.localTime = `00:${draft.localTime.slice(3)}`;

  // What: a page to watch, a goal with an end, a webhook, a mail, another run.
  const url = /\bhttps:\/\/[^\s)"'<>]+/i.exec(words)?.[0]?.replace(/[.,;]+$/, '') ?? null;
  const watching =
    /\b(if|when|once)\b.*\b(drops?|falls?|below|under|above|changes?|goes|appears?|available|in stock)\b/i.test(words) ||
    /\b(düşerse|altına|üstüne|değişirse|değişince|çıkarsa|gelirse|stoka girerse|haber ver)\b/iu.test(lower);
  if (url && watching) {
    draft.kind = 'monitor';
    draft.monitorUrl = url;
    draft.monitorCondition = words.slice(0, 500);
    if (!draft.cadence) {
      draft.cadence = 'hourly';
      draft.everyHours = 1;
      draft.localTime = '00:00';
    }
    understood.push(`watch ${url} and act when it changes`);
  } else if (/\bwebhook\b/i.test(words) || /\b(form (is )?submitted|when a form)\b/i.test(words) || /\bform (gönderil|doldurul)/iu.test(lower)) {
    draft.kind = 'webhook';
    understood.push('start when a signed webhook arrives');
  } else if (/\b(when an? (e-?mail|mail|invoice) (arrives|comes in)|forward(ed)? (e-?mails?|mails?))\b/i.test(words) || /\b(e-?posta|mail|fatura)\s+gel(diğinde|ince|irse)/iu.test(lower)) {
    draft.kind = 'email';
    understood.push('start when a mail arrives at its address');
  } else if (/\b(when|after) .*\b(run|team|automation)\b.*\b(finish(es)?|ends|completes|is done|fails)\b/i.test(words) || /\b(bittiğinde|bitince|tamamlanınca)\b/iu.test(lower)) {
    draft.kind = 'agent_event';
    understood.push('start when another run ends — choose which');
  } else if (
    draft.cadence &&
    (/\b(until|by the end of|goal|target)\b/i.test(words) || /\b(hedef|sonuna kadar|ay sonuna|bu ay)\b/iu.test(lower))
  ) {
    draft.kind = 'goal';
    draft.goalUntil = untilOf(words, today);
    understood.push(`keep going until ${draft.goalUntil}`);
  } else if (draft.cadence) {
    draft.kind = 'schedule';
  }

  if (draft.kind === 'schedule' || draft.kind === 'monitor' || draft.kind === 'goal') understood.unshift(describe(draft));
  if (draft.kind === 'manual') understood.push('run when you press run');
  return draft;
}

/** A goal's end: an explicit date, or the end of this month. */
function untilOf(text: string, today: Date): string {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1];
  if (iso) return iso;
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  return end.toISOString().slice(0, 10);
}

function describe(d: AutomationDraft): string {
  const names = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  switch (d.cadence) {
    case 'hourly':
      return d.everyHours === 1 ? `every hour at :${d.localTime?.slice(3)}` : `every ${d.everyHours} hours`;
    case 'daily':
      return `every day at ${d.localTime}`;
    case 'weekdays':
      return `weekdays at ${d.localTime}`;
    case 'weekly':
      return `every ${d.weekdays.map((n) => names[n]).join(', ')} at ${d.localTime}`;
    case 'monthly':
      return `on day ${d.monthDay} of every month at ${d.localTime}`;
    default:
      return 'when you press run';
  }
}

/** A short name from the words: the first clause, without the "every Monday at 9" around it. */
function nameOf(text: string): string {
  const cleaned = text
    .replace(/\b(every|each|her)\b[^,.;]*?\b(at|saat)\s+\S+/giu, '')
    .replace(/\bhttps:\/\/\S+/gi, '')
    .split(/[.,;:!?]/)[0]!
    .trim();
  const name = (cleaned || text).slice(0, 60).trim();
  return name.charAt(0).toLocaleUpperCase('tr') + name.slice(1);
}
