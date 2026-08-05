import { ComingSoon } from '@/components/ComingSoon';

export default function AgentsPage() {
  return (
    <ComingSoon
      title="Agents"
      phase="Phase 1+"
      blurb="The roster from sssf.config.yaml — tier, model, tools, last run — read live from agent_sessions. Cards that show which model ran each phase and how full its context window got."
    />
  );
}
