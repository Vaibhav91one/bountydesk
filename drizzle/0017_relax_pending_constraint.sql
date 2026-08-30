ALTER TABLE "agent_session" DROP CONSTRAINT "agent_session_pending_all_or_none";--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_pending_all_or_none" CHECK (("agent_session"."pending_thread_id" is null) = ("agent_session"."pending_tool_call_id" is null)
          and ("agent_session"."pending_verdict_id" is null) = ("agent_session"."pending_approved_content_hash" is null)
          and ("agent_session"."pending_thread_id" is null or "agent_session"."pending_verdict_id" is not null));