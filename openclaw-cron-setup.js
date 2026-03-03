/**
 * AAAGTMP Content Agent — OpenClaw Cron Job Setup
 * 
 * Run this ONCE to register the content agent cron job in OpenClaw.
 * The job listens for `content_brief_ready` system events and handles
 * the full generate → approve → publish pipeline.
 * 
 * Usage: node openclaw-cron-setup.js
 */

const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:3000';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;

const AGENT_PROMPT = `
You are the AAAGTMP Content Agent. Read agent-system-prompt.md for full instructions.

You have received a content brief event. The event payload is in the system context.

Your tasks:
1. Extract brief_id, content_type, topic, channel, tone, feedback from the event
2. Generate content for that channel/topic/tone following Aurion brand voice
3. PATCH {INTAKE_URL}/briefs/{brief_id}/draft with the draft
4. Send the draft to CC Puan (+6597829363) via WhatsApp for approval
5. Include [REF:{brief_id}] in your WhatsApp message so her reply can be matched

INTAKE_URL = ${process.env.INTAKE_URL}
INTAKE_SECRET = ${process.env.INTAKE_SECRET}
`.trim();

async function registerCronJob() {
  const res = await fetch(`${OPENCLAW_GATEWAY_URL}/api/cron/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
    },
    body: JSON.stringify({
      name: 'aaagtmp-content-agent',
      sessionTarget: 'isolated',
      schedule: {
        // This job is triggered on-demand via system events, not on a fixed schedule.
        // Use a very long interval as fallback — actual firing is via webhook.
        kind: 'every',
        everyMs: 86400000, // 24h — just a safety fallback
      },
      payload: {
        kind: 'agentTurn',
        message: AGENT_PROMPT,
        model: 'anthropic/claude-sonnet-4-6',
        timeoutSeconds: 120,
      },
      delivery: {
        mode: 'announce',
      },
      enabled: false, // Start disabled; webhook fires it via system events instead
    }),
  });

  const data = await res.json();
  console.log('Cron job registered:', JSON.stringify(data, null, 2));
}

registerCronJob().catch(console.error);
