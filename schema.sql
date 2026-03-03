-- ============================================================
-- AAAGTMP Content Agent — Supabase Schema
-- ============================================================
-- Apply via: Supabase SQL Editor or supabase db push

-- Enable pgcrypto for UUID generation (usually already enabled)
create extension if not exists "pgcrypto";

-- ============================================================
-- ENUM: content status lifecycle
-- ============================================================
create type content_status as enum (
  'pending',       -- brief received, not yet sent to agent
  'generating',    -- agent is working
  'draft',         -- agent returned draft, awaiting approval
  'approved',      -- CC Puan approved
  'rejected',      -- CC Puan rejected (with feedback)
  'publishing',    -- being pushed to channel
  'published',     -- live
  'failed',        -- error occurred
  'needs_human'    -- max retries exceeded, escalated
);

-- ============================================================
-- TABLE: content_briefs (main task queue)
-- ============================================================
create table if not exists content_briefs (
  id              uuid primary key default gen_random_uuid(),
  brief_id        text not null unique,            -- external dedup key (caller-provided)
  run_id          uuid default gen_random_uuid(),  -- current agent run ID

  -- Brief payload
  content_type    text not null,                   -- 'post' | 'caption' | 'article' | 'thread'
  topic           text not null,
  channel         text not null,                   -- 'instagram' | 'linkedin' | 'whatsapp' | 'twitter'
  tone            text,                            -- 'professional' | 'casual' | 'urgent'
  submitted_by    text not null,                   -- WhatsApp number or name

  -- Agent output
  draft_content   text,                            -- filled after agent generates
  final_content   text,                            -- approved/published version

  -- Approval
  approver        text,                            -- CC Puan's number or name
  feedback        text,                            -- rejection reason
  retry_count     integer not null default 0,

  -- Status
  status          content_status not null default 'pending',
  error_details   jsonb,

  -- Timestamps
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  approved_at     timestamptz,
  published_at    timestamptz
);

-- ============================================================
-- TABLE: content_run_log (full audit trail)
-- ============================================================
create table if not exists content_run_log (
  id          uuid primary key default gen_random_uuid(),
  brief_id    text not null references content_briefs(brief_id) on delete cascade,
  run_id      uuid not null,
  action      text not null,  -- 'submitted' | 'generating' | 'draft_ready' | 'approved' | 'rejected' | 'published' | 'failed' | 'escalated'
  actor       text not null,  -- 'system' | 'agent' | 'cc_puan' | 'amir'
  details     jsonb,
  created_at  timestamptz not null default now()
);

-- ============================================================
-- INDEXES — following Supabase partial index best practices
-- ============================================================

-- Active queue lookup (most frequent query pattern)
create index idx_briefs_status_pending
  on content_briefs (status, created_at desc)
  where status in ('pending', 'generating', 'draft');

-- Idempotency check
create unique index idx_briefs_brief_id
  on content_briefs (brief_id);

-- Audit log retrieval per brief
create index idx_runlog_brief_id
  on content_run_log (brief_id, created_at desc);

-- Failed / needs_human escalation view
create index idx_briefs_failed
  on content_briefs (status, updated_at desc)
  where status in ('failed', 'needs_human');

-- ============================================================
-- FUNCTION: auto-update updated_at
-- ============================================================
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger content_briefs_updated_at
  before update on content_briefs
  for each row execute function update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table content_briefs enable row level security;
alter table content_run_log enable row level security;

-- Service role has full access (agent + backend)
create policy "service_role_all_briefs"
  on content_briefs for all
  to service_role using (true);

create policy "service_role_all_logs"
  on content_run_log for all
  to service_role using (true);

-- Authenticated users can read (for dashboard later)
create policy "authenticated_read_briefs"
  on content_briefs for select
  to authenticated using (true);

create policy "authenticated_read_logs"
  on content_run_log for select
  to authenticated using (true);

-- ============================================================
-- VIEW: active queue (for monitoring)
-- ============================================================
create or replace view active_content_queue as
select
  brief_id,
  content_type,
  channel,
  topic,
  status,
  retry_count,
  submitted_by,
  created_at,
  updated_at
from content_briefs
where status not in ('published', 'failed', 'needs_human')
order by created_at asc;
