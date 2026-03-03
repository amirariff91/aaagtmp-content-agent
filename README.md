# AAAGTMP Content Agent — Setup Guide

## What This Is

Event-driven content pipeline:
Brief submitted → Supabase queue → OpenClaw agent generates → CC Puan approves → Published

No polling. No idle LLM calls. Fires only when there's real work.

## 1. Supabase Setup

Create a new Supabase project for AAAGTMP/Aurion at supabase.com.
Then run the schema:

```
# In Supabase SQL Editor → paste schema.sql and run
```

Grab these from Supabase project settings:
- SUPABASE_URL
- SUPABASE_SERVICE_KEY (service_role key — NOT anon key)

## 2. Environment Variables (set in Dokploy)

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
OPENCLAW_WEBHOOK_URL=https://your-openclaw/hooks/agent
OPENCLAW_TOKEN=your-openclaw-token
INTAKE_SECRET=generate-a-random-secret-here
PORT=3210
```

## 3. Deploy on Dokploy (nadim)

1. Push this folder to a GitHub repo
2. Create new app in Dokploy → point to repo
3. Set env vars above
4. Deploy → exposes on port 3210
5. Add domain: agent-intake.aurion.gg (or similar)

## 4. API Endpoints

All endpoints require header: `x-intake-secret: <INTAKE_SECRET>`

### Submit a brief
POST /briefs
```json
{
  "brief_id": "unique-id-from-caller",
  "content_type": "post",
  "topic": "Aurion March launch",
  "channel": "instagram",
  "tone": "professional",
  "submitted_by": "+60139844412"
}
```

Returns: 201 with run_id | 409 if duplicate | 400 if missing fields

### Check status
GET /briefs/:brief_id

### Approve draft
POST /briefs/:brief_id/approve
```json
{ "approver": "cc_puan" }
```

### Reject with feedback
POST /briefs/:brief_id/reject
```json
{
  "approver": "cc_puan",
  "feedback": "Too formal, make it more conversational"
}
```
Auto-retries up to 3x. On 3rd rejection → escalates to needs_human.

### View active queue
GET /queue

## 5. Status Lifecycle

pending → generating → draft → approved → publishing → published
                              → rejected (retries) → needs_human (max 3)
                    → failed (error)

## 6. Next Steps

- Wire OpenClaw to receive `content_brief_ready` events
- Build WhatsApp approval flow (CC Puan gets draft + approve/reject buttons)
- Add Supabase Realtime for live queue dashboard
- Connect to publish targets (Instagram API, LinkedIn API, etc.)
