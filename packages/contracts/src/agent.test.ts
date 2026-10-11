import { describe, expect, it } from 'vitest';
import { agentConversationUpdateSchema, agentMessageSchema, agentModelIdSchema, agentSupersededIds } from './agent.js';

describe('agent contracts', () => {
  it('accepts a router’s model identifier and nothing else', () => {
    expect(agentModelIdSchema.safeParse('anthropic/claude-sonnet-5-5').success).toBe(true);
    expect(agentModelIdSchema.safeParse('not a model').success).toBe(false);
  });

  it('reads a message with its defaults', () => {
    const parsed = agentMessageSchema.parse({ content: '  Hello  ' });
    expect(parsed).toEqual({ content: 'Hello', attachmentIds: [] });
    expect(agentMessageSchema.safeParse({ content: '   ' }).success).toBe(false);
    expect(agentMessageSchema.safeParse({ content: 'x', mode: 'yolo' }).success).toBe(false);
  });

  it('refuses an update that changes nothing', () => {
    expect(agentConversationUpdateSchema.safeParse({}).success).toBe(false);
    expect(agentConversationUpdateSchema.safeParse({ pinned: true }).success).toBe(true);
  });

  it('supersedes what lies between a message and its revision', () => {
    const messages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd', revises: 'b' }, { id: 'e' }];
    expect([...agentSupersededIds(messages)]).toEqual(['b', 'c']);
    // A revised message older than the window: everything before the revision.
    expect([...agentSupersededIds([{ id: 'x' }, { id: 'y', revises: 'gone' }])]).toEqual(['x']);
  });
});
