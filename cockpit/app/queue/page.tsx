import { ComingSoon } from '@/components/ComingSoon';

export default function QueuePage() {
  return (
    <ComingSoon
      title="Queue"
      phase="Phase 2"
      blurb="Launch and steer runs from the cockpit via a run_queue table + a small worker the engine drains. Cancel wires to the existing processes pid tracking. Until then, runs are kicked from the CLI and observed here."
    />
  );
}
