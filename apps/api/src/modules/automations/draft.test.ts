import { describe, expect, it } from 'vitest';
import { draftFrom, timeOf } from './draft.js';

const today = new Date(Date.UTC(2026, 9, 12));

describe('timeOf', () => {
  it.each([
    ['at 09:00', '09:00'],
    ['at 9.30', '09:30'],
    ['at 9', '09:00'],
    ['6 pm', '18:00'],
    ['12am', '00:00'],
    ['saat 9', '09:00'],
    ["18'de", '18:00'],
    ['no time here', null],
  ])('%s → %s', (text, time) => {
    expect(timeOf(text)).toBe(time);
  });
});

describe('draftFrom', () => {
  it('reads a weekly schedule in English', () => {
    expect(draftFrom('Every Monday at 9:00, write the weekly market report', today)).toMatchObject({
      kind: 'schedule',
      cadence: 'weekly',
      weekdays: [1],
      localTime: '09:00',
      understood: ['every Mon at 09:00'],
    });
  });

  it('reads a weekly schedule in Turkish, with two days', () => {
    expect(draftFrom('Her pazartesi ve cuma saat 9 haftalık pazar raporunu yaz', today)).toMatchObject({
      kind: 'schedule',
      cadence: 'weekly',
      weekdays: [1, 5],
      localTime: '09:00',
    });
  });

  it.each([
    ['every day at 18:30 summarise my inbox', 'daily', '18:30'],
    ['her gün saat 07:45 haberleri özetle', 'daily', '07:45'],
    ['on weekdays at 8 check the calendar', 'weekdays', '08:00'],
    ['hafta içi her sabah gündemi hazırla', 'weekdays', '09:00'],
    ['every evening send me a recap', 'daily', '18:00'],
  ])('%s', (text, cadence, time) => {
    expect(draftFrom(text, today)).toMatchObject({ kind: 'schedule', cadence, localTime: time });
  });

  it('reads hourly and every few hours, at a minute past', () => {
    expect(draftFrom('every 3 hours check the status page', today)).toMatchObject({ cadence: 'hourly', everyHours: 3, localTime: '00:00' });
    expect(draftFrom('saatte bir kuyruğa bak', today)).toMatchObject({ cadence: 'hourly', everyHours: 1 });
  });

  it('reads monthly on a day', () => {
    expect(draftFrom('every month on the 1st at 10:00 prepare the invoice summary', today)).toMatchObject({ cadence: 'monthly', monthDay: 1, localTime: '10:00' });
    expect(draftFrom("her ayın 15'i saat 9 bütçeyi kontrol et", today)).toMatchObject({ cadence: 'monthly', monthDay: 15 });
  });

  it('reads a monitor from a page and a condition, hourly by default', () => {
    expect(draftFrom('Tell me if the price at https://shop.example.com/item/42 drops below 2000 TL', today)).toMatchObject({
      kind: 'monitor',
      monitorUrl: 'https://shop.example.com/item/42',
      cadence: 'hourly',
      everyHours: 1,
    });
    expect(draftFrom('https://shop.example.com/x fiyatı 2000 TL altına düşerse haber ver', today)).toMatchObject({ kind: 'monitor' });
  });

  it('reads a goal that runs until the end of the month', () => {
    expect(draftFrom('Every weekday at 10, find qualified leads until we have 20 — goal for this month', today)).toMatchObject({
      kind: 'goal',
      cadence: 'weekdays',
      goalUntil: '2026-10-31',
    });
  });

  it('reads a webhook, a mail and a run event', () => {
    expect(draftFrom('When a form is submitted, qualify the lead', today).kind).toBe('webhook');
    expect(draftFrom('Fatura geldiğinde özetle ve takvime ekle', today).kind).toBe('email');
    expect(draftFrom('When the research team run finishes, start the content team', today).kind).toBe('agent_event');
  });

  it('leaves what it cannot read as a manual automation, with the words as its prompt', () => {
    const draft = draftFrom('Draft a thank-you note to the team', today);
    expect(draft).toMatchObject({ kind: 'manual', cadence: null, prompt: 'Draft a thank-you note to the team', understood: ['run when you press run'] });
    expect(draft.name).toBe('Draft a thank-you note to the team');
  });

  it('names it from the words, without the schedule around them', () => {
    expect(draftFrom('Every Monday at 9:00, write the weekly market report', today).name).toBe('Write the weekly market report');
  });
});
