/**
 * AAAGTMP Content Agent — Webhook Intake
 * 
 * Receives content briefs, validates, idempotency-checks,
 * writes to Supabase queue, then fires OpenClaw agent.
 * 
 * Deploy on: Dokploy (nadim) or Coolify (radi)
 * Port: 3210 (or set PORT env var)
 */

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const app = express();
app.use(express.json());

// ── Route: GET / ──────────────────────────────────────────────
app.get('/', (req, res) => res.json({ service: 'aaagtmp-content-agent', status: 'ok', version: '1.0.0' }));


// ── Config (set as env vars in Dokploy/Coolify) ─────────────
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  OPENCLAW_WEBHOOK_URL,   // e.g. https://your-openclaw.com/hooks/agent
  OPENCLAW_TOKEN,         // OpenClaw webhook secret
  INTAKE_SECRET,          // Shared secret for this intake endpoint
  PORT = '3210',
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Middleware: verify caller ────────────────────────────────
function verifySecret(req, res, next) {
  const token = req.headers['x-intake-secret'];
  if (!INTAKE_SECRET || token !== INTAKE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Helpers ──────────────────────────────────────────────────
async function writeLog(briefId, runId, action, actor, details = {}) {
  await supabase.from('content_run_log').insert({
    brief_id: briefId,
    run_id: runId,
    action,
    actor,
    details,
  });
}

async function fireAgent(brief) {
  /**
   * Fires OpenClaw agent with the content brief.
   * OpenClaw will orchestrate the LLM call + approval flow.
   */
  const res = await fetch(OPENCLAW_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
    },
    body: JSON.stringify({
      event: 'content_brief_ready',
      brief_id: brief.brief_id,
      run_id: brief.run_id,
      content_type: brief.content_type,
      topic: brief.topic,
      channel: brief.channel,
      tone: brief.tone,
      submitted_by: brief.submitted_by,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenClaw webhook failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

// ── Route: POST /briefs ───────────────────────────────────────
app.post('/briefs', verifySecret, async (req, res) => {
  const { brief_id, content_type, topic, channel, tone, submitted_by } = req.body;

  // 1. Validate required fields
  const required = { brief_id, content_type, topic, channel, submitted_by };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    return res.status(400).json({ error: 'Missing fields', fields: missing });
  }

  // 2. Idempotency check — reject duplicate brief_ids
  const { data: existing } = await supabase
    .from('content_briefs')
    .select('brief_id, status, run_id')
    .eq('brief_id', brief_id)
    .maybeSingle();

  if (existing) {
    return res.status(409).json({
      error: 'Brief already exists',
      brief_id,
      status: existing.status,
      run_id: existing.run_id,
    });
  }

  // 3. Insert to queue
  const run_id = crypto.randomUUID();

  const { data: brief, error: insertError } = await supabase
    .from('content_briefs')
    .insert({
      brief_id,
      run_id,
      content_type,
      topic,
      channel,
      tone: tone || null,
      submitted_by,
      status: 'pending',
    })
    .select()
    .single();

  if (insertError) {
    console.error('Insert error:', insertError);
    return res.status(500).json({ error: 'Failed to queue brief', detail: insertError.message });
  }

  // 4. Log submission
  await writeLog(brief_id, run_id, 'submitted', 'system', { content_type, topic, channel });

  // 5. Update status → generating
  await supabase
    .from('content_briefs')
    .update({ status: 'generating' })
    .eq('brief_id', brief_id);

  await writeLog(brief_id, run_id, 'generating', 'system');

  // 6. Fire OpenClaw agent (async — don't block response)
  fireAgent(brief).catch(async (err) => {
    console.error('Agent fire failed:', err.message);
    await supabase
      .from('content_briefs')
      .update({ status: 'failed', error_details: { message: err.message } })
      .eq('brief_id', brief_id);
    await writeLog(brief_id, run_id, 'failed', 'system', { error: err.message });
  });

  // 7. Respond immediately
  return res.status(201).json({
    brief_id,
    run_id,
    status: 'generating',
    message: 'Brief queued. Agent is generating.',
  });
});

// ── Route: GET /briefs/:brief_id ──────────────────────────────
app.get('/briefs/:brief_id', verifySecret, async (req, res) => {
  const { data, error } = await supabase
    .from('content_briefs')
    .select('*')
    .eq('brief_id', req.params.brief_id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Not found' });
  return res.json(data);
});

// ── Route: POST /briefs/:brief_id/approve ─────────────────────
app.post('/briefs/:brief_id/approve', verifySecret, async (req, res) => {
  const { approver } = req.body;
  const { brief_id } = req.params;

  const { data: brief } = await supabase
    .from('content_briefs')
    .select('*')
    .eq('brief_id', brief_id)
    .single();

  if (!brief) return res.status(404).json({ error: 'Not found' });
  if (brief.status !== 'draft') {
    return res.status(409).json({ error: `Cannot approve brief in status: ${brief.status}` });
  }

  await supabase.from('content_briefs').update({
    status: 'approved',
    approver: approver || 'cc_puan',
    approved_at: new Date().toISOString(),
  }).eq('brief_id', brief_id);

  await writeLog(brief_id, brief.run_id, 'approved', approver || 'cc_puan');

  // Fire publish step (OpenClaw handles this)
  fireAgent({ ...brief, status: 'approved' }).catch(console.error);

  return res.json({ brief_id, status: 'approved' });
});

// ── Route: POST /briefs/:brief_id/reject ──────────────────────
app.post('/briefs/:brief_id/reject', verifySecret, async (req, res) => {
  const { approver, feedback } = req.body;
  const { brief_id } = req.params;

  const { data: brief } = await supabase
    .from('content_briefs')
    .select('*')
    .eq('brief_id', brief_id)
    .single();

  if (!brief) return res.status(404).json({ error: 'Not found' });

  const newRetryCount = (brief.retry_count || 0) + 1;
  const maxRetries = 3;

  if (newRetryCount >= maxRetries) {
    await supabase.from('content_briefs').update({
      status: 'needs_human',
      feedback,
      retry_count: newRetryCount,
    }).eq('brief_id', brief_id);

    await writeLog(brief_id, brief.run_id, 'escalated', 'system', {
      reason: 'max_retries_exceeded',
      feedback,
    });

    return res.json({ brief_id, status: 'needs_human', message: 'Escalated to Amir' });
  }

  // Retry: new run_id, back to generating
  const new_run_id = crypto.randomUUID();

  await supabase.from('content_briefs').update({
    status: 'generating',
    feedback,
    retry_count: newRetryCount,
    run_id: new_run_id,
  }).eq('brief_id', brief_id);

  await writeLog(brief_id, new_run_id, 'rejected', approver || 'cc_puan', { feedback });
  await writeLog(brief_id, new_run_id, 'generating', 'system', { retry: newRetryCount });

  // Re-fire agent with feedback context
  fireAgent({ ...brief, run_id: new_run_id, feedback, retry_count: newRetryCount })
    .catch(console.error);

  return res.json({ brief_id, status: 'generating', retry: newRetryCount });
});

// ── Route: PATCH /briefs/:brief_id/draft ─────────────────────
// Called by OpenClaw agent after generating content
app.patch('/briefs/:brief_id/draft', verifySecret, async (req, res) => {
  const { draft_content } = req.body;
  const { brief_id } = req.params;

  if (!draft_content) return res.status(400).json({ error: 'draft_content required' });

  const { data: brief } = await supabase
    .from('content_briefs')
    .select('*')
    .eq('brief_id', brief_id)
    .single();

  if (!brief) return res.status(404).json({ error: 'Not found' });

  await supabase.from('content_briefs').update({
    status: 'draft',
    draft_content,
  }).eq('brief_id', brief_id);

  await writeLog(brief_id, brief.run_id, 'draft_ready', 'agent', {
    content_type: brief.content_type,
    channel: brief.channel,
  });

  return res.json({ brief_id, status: 'draft', message: 'Draft stored. Awaiting approval.' });
});

// ── Route: GET /queue ─────────────────────────────────────────
app.get('/queue', verifySecret, async (req, res) => {
  const { data } = await supabase
    .from('active_content_queue')
    .select('*');
  return res.json(data || []);
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(parseInt(PORT), () => {
  console.log(`Content Agent intake running on :${PORT}`);
});
