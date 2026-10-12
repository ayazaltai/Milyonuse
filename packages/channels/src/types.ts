/**
 * What every channel is reduced to (ported from Agent 5.5
 * `gateway/adapter.py`): a message or a button press in, a message with
 * buttons out. The adapters are pure — they check a signature, read a
 * payload and say what to send — so the API decides when and through what
 * anything leaves, and every adapter is tested without a network.
 */

export const PROVIDERS = ['telegram', 'whatsapp', 'slack', 'discord', 'email'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** A request as it arrived: the untouched body is what a signature covers. */
export interface ChannelRequest {
  headers: Record<string, string | undefined>;
  rawBody: string;
  /** Milliseconds; for a signature's freshness. */
  now?: number;
}

export interface InboundMessage {
  kind: 'message';
  provider: Provider;
  /** The channel's id for this delivery: the same id again is the same delivery. */
  eventId: string;
  /** The channel's id for the sender — what a pairing binds. */
  senderId: string;
  /** Where a reply goes. */
  chatId: string;
  displayName: string;
  text: string;
  /** A group, a channel or a server: anyone there may have written it. */
  isGroup: boolean;
  /** `/report this week` → { name: 'report', args: 'this week' }. */
  command: { name: string; args: string } | null;
}

export interface ButtonPress {
  kind: 'button';
  provider: Provider;
  eventId: string;
  senderId: string;
  chatId: string;
  displayName: string;
  /** What the button carried: see `encodeAction`. */
  data: string;
  /** The channel's handle to acknowledge the press with, when it wants one. */
  ackId: string | null;
}

export type InboundEvent = InboundMessage | ButtonPress;

/** A button: one that answers back with `data`, or one that opens `url`. */
export type Button = { label: string; data: string; url?: undefined } | { label: string; url: string; data?: undefined };

export interface OutboundMessage {
  chatId: string;
  text: string;
  buttons?: Button[];
}

/** What to send, built by an adapter and sent by the API. */
export type OutgoingCall =
  | { kind: 'http'; url: string; method: 'POST'; headers: Record<string, string>; body: string }
  | { kind: 'mail'; to: string; subject: string; text: string };

/** An answer the channel needs in the webhook's own response: a handshake or an interaction's acknowledgement. */
export interface ImmediateAnswer {
  status: number;
  contentType: 'application/json' | 'text/plain';
  body: string;
}

export interface ChannelAdapter {
  readonly provider: Provider;
  /** Whether the request was signed by the channel. Nothing unsigned is read further. */
  verify(request: ChannelRequest): boolean;
  /** The messages and button presses in a verified payload; anything else is ignored. */
  parse(body: unknown): InboundEvent[];
  /** What the channel needs answered right away, if anything — before the work is queued. */
  immediate(body: unknown): ImmediateAnswer | null;
  /** The calls that deliver a message. */
  send(message: OutboundMessage): OutgoingCall[];
  /** The call that tells the channel a button press was received, where it asks for one. */
  ack(press: ButtonPress, note?: string): OutgoingCall | null;
}
