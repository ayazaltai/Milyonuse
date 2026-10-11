import { agentTimeZoneSchema } from '@milyonuse/contracts';
import { z } from 'zod';
import { localTime } from '../prompt.js';
import { type AgentTool, tool } from './tool.js';

/**
 * `current_time` — the time now, in the person's zone or another. The
 * prompt states the time when the turn began; this is for when exact time
 * matters, or another zone is asked about.
 */
export function timeTool(clock: () => Date = () => new Date()): AgentTool {
  return tool({
    name: 'current_time',
    source: false,
    summary: 'Checked the time',
    description:
      'The current date and time, in the person’s time zone or in another IANA time zone (e.g. "America/New_York"). Changes nothing.',
    schema: z.object({
      timeZone: agentTimeZoneSchema.optional().describe('An IANA time zone; the person’s own when omitted.'),
    }),
    run: (context, args) => {
      const now = clock();
      const zone = args.timeZone ?? context.timeZone;
      return Promise.resolve({
        kind: 'data',
        data: { utc: now.toISOString(), timeZone: zone, local: localTime(now, zone) },
      });
    },
  });
}
