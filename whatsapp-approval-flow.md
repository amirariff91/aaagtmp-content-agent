# WhatsApp Approval Flow — CC Puan

## How It Works

1. Agent generates draft → stores in Supabase
2. Agent sends CC Puan a DM via WhatsApp bot (+60172491583)
3. CC Puan reads draft and replies
4. OpenClaw (Miccy) detects the reply, parses it, routes to intake API
5. Pipeline continues

---

## Message to CC Puan (exact format)

```
[REF:abc-123-def]

✍️ New content draft ready for your review:

*Type:* Post | *Channel:* Instagram
*Topic:* Aurion March launch announcement

---
[Generated draft content here]
---

Reply with:
✅ *APPROVE* — to publish as-is
❌ *REJECT: [your feedback]* — to request revisions

_(Ref: abc-123-def)_
```

---

## CC Puan's Reply Patterns

| Her reply | What happens |
|-----------|-------------|
| `APPROVE` | Draft published, CC Puan confirmed |
| `Approved` / `ok approved` | Same — case-insensitive, fuzzy match |
| `REJECT: too formal, simplify` | Agent revises with that feedback |
| `Reject - add more emojis` | Same — dash or colon separator both work |
| Anything ambiguous | Bot asks for clarification politely |

---

## Reply Parsing Logic (in Miccy/OpenClaw)

When a WhatsApp DM arrives from CC Puan (+6597829363):

```js
const text = message.toLowerCase().trim();
const refMatch = quotedMessage?.match(/\[REF:([\w-]+)\]/);
const briefId = refMatch?.[1];

if (!briefId) {
  // Ask CC Puan to reference the brief
  reply("Hi CC Puan — which brief is this for? Include the [REF:...] code.");
  return;
}

if (text.startsWith('approve') || text === 'ok' || text.includes('approved')) {
  await fetch(`${INTAKE_URL}/briefs/${briefId}/approve`, { method: 'POST', ... });
  reply("✅ Got it — publishing now!");
} else if (text.startsWith('reject')) {
  const feedback = message.replace(/^reject[:\-\s]*/i, '').trim();
  await fetch(`${INTAKE_URL}/briefs/${briefId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ approver: 'cc_puan', feedback }),
  });
  reply("Got it. Revising with your notes — new draft coming shortly.");
} else {
  reply("Hi CC Puan — just reply APPROVE or REJECT: [feedback] for this draft. Thanks!");
}
```

---

## Edge Cases

**CC Puan doesn't reply within 24h:**
- Cron job (daily) checks for briefs stuck in `draft` status > 24h
- Sends a gentle reminder to CC Puan
- Notifies Amir if still no response after 48h

**CC Puan rejects 3 times:**
- Status → `needs_human`
- Amir gets a WhatsApp alert with the full history
- Manual intervention required

**Draft is for multiple channels:**
- Each channel = separate brief_id
- CC Puan gets one message per channel
- Can approve/reject independently

---

## Publishing Targets (post-approval)

| Channel | How to publish |
|---------|---------------|
| Instagram | Meta Graph API (requires IG Business account) |
| LinkedIn | LinkedIn API (requires company page access) |
| WhatsApp | Send to group/broadcast via OpenClaw message tool |
| Twitter/X | Twitter API v2 |

For the March 4 demo — publishing can be simulated (log to Supabase + confirm in WhatsApp). Real channel integrations can be wired post-demo.
