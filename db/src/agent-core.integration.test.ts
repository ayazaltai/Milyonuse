import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { APP_URL, PLATFORM_URL, asTenant, hintOf } from './testing.js';

/**
 * The rules 0006_agent_core enforces: a conversation is one person's, what
 * was said is never edited, an edit is a revision of the person's own words,
 * the summary only moves forward, only the agent's answers are rated, and a
 * usage count only grows.
 */

const app = new pg.Pool({ connectionString: APP_URL, max: 3 });
const platform = new pg.Pool({ connectionString: PLATFORM_URL, max: 3 });
const suffix = Date.now().toString(36);

const PASSWORD_HASH =
  'scrypt$15$8$3$qAJmqqKLyfYY7Z9RM6y3qQ$LuwxjHraHT_UDEhntpNf9xhQWa2rg1CV2PEWHg6eUCLhCCXRcDQY5ukct94f5eqPpJjWYYYaaVrHNbHATJTB7w';

interface Person {
  organizationId: string;
  memberId: string;
}

let ada: Person;
let grace: Person;
/** Someone in another organization altogether. */
let linus: Person;

async function user(name: string): Promise<string> {
  const { rows } = await platform.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
    [`${name}-${suffix}@agent-core.test`, name],
  );
  await platform.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [rows[0]!.id, PASSWORD_HASH]);
  return rows[0]!.id;
}

async function member(organizationId: string, userId: string, role: string): Promise<Person> {
  const { rows } = await platform.query<{ id: string }>(
    `INSERT INTO members (organization_id, user_id, role) VALUES ($1, $2, $3) RETURNING id`,
    [organizationId, userId, role],
  );
  return { organizationId, memberId: rows[0]!.id };
}

async function conversation(person: Person, title = 'Plans'): Promise<string> {
  return asTenant(app, person, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO agent_conversations (organization_id, member_id, title, model)
       VALUES ($1, $2, $3, 'anthropic/claude-sonnet-5-5') RETURNING id`,
      [person.organizationId, person.memberId, title],
    );
    return rows[0]!.id;
  });
}

async function say(
  person: Person,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  revises?: string,
): Promise<{ id: string; created_at: string }> {
  return asTenant(app, person, async (c) => {
    // As text: a JavaScript Date keeps milliseconds, the column keeps microseconds.
    const { rows } = await c.query<{ id: string; created_at: string }>(
      `INSERT INTO agent_messages (organization_id, conversation_id, role, content, revises, model, prompt_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at::text`,
      [
        person.organizationId,
        conversationId,
        role,
        content,
        revises ?? null,
        role === 'assistant' ? 'anthropic/claude-sonnet-5-5' : null,
        role === 'assistant' ? 'v1' : null,
      ],
    );
    return rows[0]!;
  });
}

beforeAll(async () => {
  const [adaId, graceId, linusId] = [await user('ada'), await user('grace'), await user('linus')];
  // A shared workspace: two people, one organization — where privacy between
  // members is something the policy has to provide.
  const { rows } = await platform.query<{ id: string }>(
    `INSERT INTO organizations (name, kind, owner_user_id) VALUES ('Shared', 'shared', $1) RETURNING id`,
    [adaId],
  );
  ada = await member(rows[0]!.id, adaId, 'owner');
  grace = await member(rows[0]!.id, graceId, 'member');
  const own = await platform.query<{ id: string }>(
    `INSERT INTO organizations (name, kind, owner_user_id) VALUES ('Linus', 'personal', $1) RETURNING id`,
    [linusId],
  );
  linus = await member(own.rows[0]!.id, linusId, 'owner');
});

afterAll(async () => {
  await platform.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${suffix}@agent-core.test`]);
  await Promise.all([app.end(), platform.end()]);
});

describe('a conversation is one person’s', () => {
  it('is invisible to another member of the same organization', async () => {
    const id = await conversation(ada);
    await say(ada, id, 'user', 'Private thought');
    const seen = await asTenant(app, grace, async (c) => ({
      conversations: (await c.query(`SELECT 1 FROM agent_conversations WHERE id = $1`, [id])).rowCount,
      messages: (await c.query(`SELECT 1 FROM agent_messages WHERE conversation_id = $1`, [id])).rowCount,
    }));
    expect(seen).toEqual({ conversations: 0, messages: 0 });
  });

  it('is invisible with only the organization in scope', async () => {
    await conversation(ada);
    const { rowCount } = await asTenant(app, ada.organizationId, (c) => c.query(`SELECT 1 FROM agent_conversations`));
    expect(rowCount).toBe(0);
  });

  it('cannot be opened in another member’s name', async () => {
    await expect(
      asTenant(app, ada, (c) =>
        c.query(
          `INSERT INTO agent_conversations (organization_id, member_id, model) VALUES ($1, $2, 'm/x')`,
          [grace.organizationId, grace.memberId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot name a member of another organization', async () => {
    const error = await platform
      .query(`INSERT INTO agent_conversations (organization_id, member_id, model) VALUES ($1, $2, 'm/x')`, [
        ada.organizationId,
        linus.memberId,
      ])
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('42501');
  });

  it('does not let a message into someone else’s conversation', async () => {
    const id = await conversation(ada);
    await expect(say(grace, id, 'user', 'Hello?')).rejects.toThrow();
    await expect(say(linus, id, 'user', 'Hello?')).rejects.toThrow();
  });

  it('keeps model names to a router identifier', async () => {
    await expect(
      asTenant(app, ada, (c) =>
        c.query(`INSERT INTO agent_conversations (organization_id, member_id, model) VALUES ($1, $2, 'not a model')`, [
          ada.organizationId,
          ada.memberId,
        ]),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('what was said', () => {
  it('is never edited', async () => {
    const id = await conversation(ada);
    const message = await say(ada, id, 'user', 'Original');
    const error = await asTenant(app, ada, (c) =>
      c.query(`DELETE FROM agent_messages WHERE id = $1`, [message.id]),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    // The application role cannot even ask; the rule holds for the platform too.
    const update = await platform
      .query(`UPDATE agent_messages SET content = 'x' WHERE id = $1`, [message.id])
      .catch((e: unknown) => e);
    expect(update).toBeInstanceOf(Error);
  });

  it('goes with its conversation', async () => {
    const id = await conversation(ada);
    await say(ada, id, 'user', 'One');
    await say(ada, id, 'assistant', 'Two');
    await asTenant(app, ada, (c) => c.query(`DELETE FROM agent_conversations WHERE id = $1`, [id]));
    const { rowCount } = await platform.query(`SELECT 1 FROM agent_messages WHERE conversation_id = $1`, [id]);
    expect(rowCount).toBe(0);
  });

  it('reads back in the order it was written, within one transaction', async () => {
    const id = await conversation(ada);
    const order = await asTenant(app, ada, async (c) => {
      for (const content of ['a', 'b', 'c']) {
        await c.query(
          `INSERT INTO agent_messages (organization_id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)`,
          [ada.organizationId, id, content],
        );
      }
      const { rows } = await c.query<{ content: string }>(
        `SELECT content FROM agent_messages WHERE conversation_id = $1 ORDER BY created_at, id`,
        [id],
      );
      return rows.map((r) => r.content).join('');
    });
    expect(order).toBe('abc');
  });

  it('keeps spend on the agent’s messages and tool calls on its answers', async () => {
    const id = await conversation(ada);
    const insert = (sql: string) => asTenant(app, ada, (c) => c.query(sql, [ada.organizationId, id]));
    await expect(
      insert(`INSERT INTO agent_messages (organization_id, conversation_id, role, tokens_in) VALUES ($1, $2, 'user', 10)`),
    ).rejects.toThrow(/agent_messages_spend_is_the_agents/);
    await expect(
      insert(`INSERT INTO agent_messages (organization_id, conversation_id, role, tool_calls) VALUES ($1, $2, 'user', '[]')`),
    ).rejects.toThrow(/agent_messages_calls_are_the_agents/);
    await expect(
      insert(`INSERT INTO agent_messages (organization_id, conversation_id, role) VALUES ($1, $2, 'tool')`),
    ).rejects.toThrow(/agent_messages_tool_answer/);
  });
});

describe('a revision', () => {
  it('replaces an earlier message of the person’s', async () => {
    const id = await conversation(ada);
    const first = await say(ada, id, 'user', 'Draft');
    await say(ada, id, 'assistant', 'Answer');
    const revision = await say(ada, id, 'user', 'Better draft', first.id);
    expect(revision.id).toBeTruthy();
  });

  it('cannot revise the agent’s words', async () => {
    const id = await conversation(ada);
    const answer = await say(ada, id, 'assistant', 'Answer');
    const error = await say(ada, id, 'user', 'No', answer.id).catch((e: unknown) => e);
    expect(hintOf(error)).toBe('agent_revision_invalid');
  });

  it('cannot reach into another conversation', async () => {
    const [one, two] = [await conversation(ada), await conversation(ada)];
    const message = await say(ada, one, 'user', 'Here');
    const error = await say(ada, two, 'user', 'There', message.id).catch((e: unknown) => e);
    expect(hintOf(error)).toBe('agent_revision_invalid');
  });
});

describe('the summary', () => {
  async function summarise(person: Person, id: string, through: { id: string; created_at: string } | null) {
    return asTenant(app, person, (c) =>
      c.query(
        `UPDATE agent_conversations
            SET summary = $2, summary_through_id = $3, summary_through_at = $4, summarized_at = $5
          WHERE id = $1`,
        [id, through ? 'So far' : null, through?.id ?? null, through?.created_at ?? null, through ? new Date() : null],
      ),
    );
  }

  it('ends at one of the conversation’s own messages and moves forward', async () => {
    const id = await conversation(ada);
    const first = await say(ada, id, 'user', 'One');
    const second = await say(ada, id, 'assistant', 'Two');
    await summarise(ada, id, second);
    expect(hintOf(await summarise(ada, id, first).catch((e: unknown) => e))).toBe('agent_summary_boundary');
    expect(hintOf(await summarise(ada, id, null).catch((e: unknown) => e))).toBe('agent_summary_boundary');
  });

  it('cannot end in another conversation', async () => {
    const [one, two] = [await conversation(ada), await conversation(ada)];
    const elsewhere = await say(ada, two, 'user', 'Elsewhere');
    expect(hintOf(await summarise(ada, one, elsewhere).catch((e: unknown) => e))).toBe('agent_summary_boundary');
  });

  it('is written whole', async () => {
    const id = await conversation(ada);
    await expect(
      asTenant(app, ada, (c) => c.query(`UPDATE agent_conversations SET summary = 'x' WHERE id = $1`, [id])),
    ).rejects.toThrow(/agent_conversations_summary_whole/);
  });
});

describe('attachments', () => {
  it('hold a table as cells or a document as text, never both', async () => {
    const id = await conversation(ada);
    const insert = (kind: string, rows: string, rowCount: number, columns: number, text: string | null) =>
      asTenant(app, ada, (c) =>
        c.query(
          `INSERT INTO agent_attachments (organization_id, member_id, conversation_id, kind, name, rows, row_count, column_count, text)
           VALUES ($1, $2, $3, $4, 'file', $5, $6, $7, $8)`,
          [ada.organizationId, ada.memberId, id, kind, rows, rowCount, columns, text],
        ),
      );
    await insert('table', '[["a","b"],["1","2"]]', 2, 2, null);
    await insert('document', '[]', 0, 0, 'Some text');
    await expect(insert('document', '[["a"]]', 1, 1, 'Text')).rejects.toThrow(/agent_attachments_shape/);
    await expect(insert('table', '[]', 0, 0, null)).rejects.toThrow(/agent_attachments_shape/);
  });

  it('stay a few days at most', async () => {
    const id = await conversation(ada);
    await expect(
      asTenant(app, ada, (c) =>
        c.query(
          `INSERT INTO agent_attachments (organization_id, member_id, conversation_id, kind, name, text, expires_at)
           VALUES ($1, $2, $3, 'document', 'f', 'x', now() + interval '90 days')`,
          [ada.organizationId, ada.memberId, id],
        ),
      ),
    ).rejects.toThrow(/agent_attachments_short_lived/);
  });

  it('belong to the conversation’s own person', async () => {
    const id = await conversation(ada);
    const error = await platform
      .query(
        `INSERT INTO agent_attachments (organization_id, member_id, conversation_id, kind, name, text)
         VALUES ($1, $2, $3, 'document', 'f', 'x')`,
        [grace.organizationId, grace.memberId, id],
      )
      .catch((e: unknown) => e);
    // The platform role may not write here at all; the composite key would refuse it anyway.
    expect(error).toBeInstanceOf(Error);
  });
});

describe('feedback', () => {
  async function rate(person: Person, messageId: string, rating = 1) {
    return asTenant(app, person, async (c) => {
      const { rows } = await c.query<{ model: string | null; prompt_version: string | null }>(
        `INSERT INTO agent_feedback (organization_id, member_id, message_id, rating) VALUES ($1, $2, $3, $4)
         RETURNING model, prompt_version`,
        [person.organizationId, person.memberId, messageId, rating],
      );
      return rows[0]!;
    });
  }

  it('rates an answer and keeps what answered it', async () => {
    const id = await conversation(ada);
    const answer = await say(ada, id, 'assistant', 'Answer');
    expect(await rate(ada, answer.id)).toEqual({ model: 'anthropic/claude-sonnet-5-5', prompt_version: 'v1' });
  });

  it('does not rate the person’s own words', async () => {
    const id = await conversation(ada);
    const question = await say(ada, id, 'user', 'Question');
    expect(hintOf(await rate(ada, question.id).catch((e: unknown) => e))).toBe('agent_feedback_invalid');
  });

  it('does not rate someone else’s conversation', async () => {
    const id = await conversation(ada);
    const answer = await say(ada, id, 'assistant', 'Answer');
    expect(hintOf(await rate(grace, answer.id).catch((e: unknown) => e))).toBe('agent_feedback_invalid');
  });

  it('is one rating per answer, changed in place', async () => {
    const id = await conversation(ada);
    const answer = await say(ada, id, 'assistant', 'Answer');
    await rate(ada, answer.id, 1);
    await expect(rate(ada, answer.id, -1)).rejects.toThrow(/duplicate key/);
    await asTenant(app, ada, (c) =>
      c.query(`UPDATE agent_feedback SET rating = -1, note = 'Wrong' WHERE message_id = $1`, [answer.id]),
    );
  });
});

describe('usage', () => {
  const day = '2026-10-10';

  async function count(person: Person, events: number, quantity: number) {
    return asTenant(app, person, (c) =>
      c.query(
        `INSERT INTO usage_daily (organization_id, member_id, day, meter, events, quantity) VALUES ($1, $2, $3, 'agent.tokens', $4, $5)
         ON CONFLICT ON CONSTRAINT usage_daily_once
         DO UPDATE SET events = usage_daily.events + EXCLUDED.events,
                       quantity = usage_daily.quantity + EXCLUDED.quantity, last_at = now()`,
        [person.organizationId, person.memberId, day, events, quantity],
      ),
    );
  }

  it('adds up in one row per person, day and meter', async () => {
    await count(linus, 1, 100);
    await count(linus, 1, 50);
    const { rows } = await asTenant(app, linus, (c) =>
      c.query<{ events: number; quantity: string }>(`SELECT events, quantity FROM usage_daily WHERE day = $1`, [day]),
    );
    expect(rows).toEqual([{ events: 2, quantity: '150' }]);
  });

  it('only grows', async () => {
    await count(grace, 1, 100);
    const error = await asTenant(app, grace, (c) =>
      c.query(`UPDATE usage_daily SET quantity = 1 WHERE member_id = $1`, [grace.memberId]),
    ).catch((e: unknown) => e);
    expect(hintOf(error)).toBe('usage_only_grows');
  });

  it('is never deleted by the application', async () => {
    await expect(asTenant(app, linus, (c) => c.query(`DELETE FROM usage_daily`))).rejects.toThrow(/permission denied/);
  });
});
