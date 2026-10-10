import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailboxApiMailer, parseFrom } from './mailbox-api.mailer.js';

const BASE = 'https://mail-api.example.test';

function mailer(from = 'Milyonus <ayaz@milyonus.com>') {
  return new MailboxApiMailer({ baseUrl: BASE, token: 'secret-token', from });
}

/** The provider: its account lookup, then a 204 for each send. */
function provider(mailboxes = [{ resourceId: 'AC123', address: 'ayaz@milyonus.com' }]) {
  const fetchMock = vi.fn(async (url: URL | string) => {
    if (String(url).endsWith('/api/v1/me')) {
      return new Response(JSON.stringify({ data: { orderResourceId: 'OR1', mailboxes } }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function call(fetchMock: ReturnType<typeof vi.fn>, n: number) {
  const [url, init] = fetchMock.mock.calls[n] as [URL, RequestInit & { headers: Record<string, string> }];
  return { url: String(url), init, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null };
}

afterEach(() => vi.unstubAllGlobals());

describe('MailboxApiMailer', () => {
  it('sends from the mailbox MAIL_FROM names, under its display name, with the bearer token', async () => {
    const fetchMock = provider();
    await mailer().send({ to: 'ada@acme.test', subject: 'Your interview', text: 'Join here.', html: '<p>Join here.</p>' });

    expect(call(fetchMock, 0).url).toBe(`${BASE}/api/v1/me`);
    const send = call(fetchMock, 1);
    expect(send.url).toBe(`${BASE}/api/v1/mailboxes/AC123/send`);
    expect(send.init.method).toBe('POST');
    expect(send.init.headers['authorization']).toBe('Bearer secret-token');
    expect(send.body).toEqual({
      to: ['ada@acme.test'],
      subject: 'Your interview',
      text: 'Join here.',
      html: '<p>Join here.</p>',
      displayName: 'Milyonus',
    });
  });

  it('looks the mailbox up once, however many messages follow', async () => {
    const fetchMock = provider();
    const m = mailer();
    await m.send({ to: 'a@acme.test', subject: 's', text: 't' });
    await m.send({ to: 'b@acme.test', subject: 's', text: 't' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/me'))).toHaveLength(1);
  });

  it('attaches a calendar invite base64-encoded, as the provider expects', async () => {
    const fetchMock = provider();
    const ics = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n';
    await mailer().send({
      to: 'ada@acme.test',
      subject: 'Invite',
      text: 't',
      attachments: [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; method=REQUEST' }],
    });
    expect(call(fetchMock, 1).body!['attachments']).toEqual([
      {
        filename: 'invite.ics',
        contentType: 'text/calendar; method=REQUEST',
        content: Buffer.from(ics, 'utf8').toString('base64'),
        encoding: 'base64',
      },
    ]);
  });

  it('refuses a MAIL_FROM the token cannot send from — and asks again next time', async () => {
    const fetchMock = provider([{ resourceId: 'AC9', address: 'someone@else.test' }]);
    const m = mailer('Milyonus <no-reply@milyonus.com>');
    await expect(m.send({ to: 'a@acme.test', subject: 's', text: 't' })).rejects.toThrow(
      /no-reply@milyonus.com, which is not a mailbox this API token can send from/,
    );
    await expect(m.send({ to: 'a@acme.test', subject: 's', text: 't' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports the provider's status and code, never its message or the recipient", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | string) =>
        String(url).endsWith('/api/v1/me')
          ? new Response(JSON.stringify({ data: { mailboxes: [{ resourceId: 'AC1', address: 'ayaz@milyonus.com' }] } }))
          : new Response(
              JSON.stringify({ code: 'ERR_VALIDATION_FAILED', error: 'to[0] ada@acme.test is invalid', params: {} }),
              { status: 422 },
            ),
      ),
    );
    const error = (await mailer()
      .send({ to: 'ada@acme.test', subject: 's', text: 't' })
      .then(() => null)
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('Mailbox API answered 422 ERR_VALIDATION_FAILED.');
    expect(error.message).not.toContain('ada@acme.test');
  });
});

describe('parseFrom', () => {
  it('reads a name and an address, or a bare address', () => {
    expect(parseFrom('Milyonus <no-reply@milyonus.com>')).toEqual({ name: 'Milyonus', address: 'no-reply@milyonus.com' });
    expect(parseFrom('"Milyonus Talent" <talent@milyonus.com>')).toEqual({
      name: 'Milyonus Talent',
      address: 'talent@milyonus.com',
    });
    expect(parseFrom('ayaz@milyonus.com')).toEqual({ name: null, address: 'ayaz@milyonus.com' });
  });
});
