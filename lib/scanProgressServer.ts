/**
 * Single server helper for scan job progress.
 * Both scan paths (worker + blocking) must call this so [SCAN_PROGRESS_WRITE] proves the path ran.
 * Checkpoints: 2 starting, 10 downloading, 20 optimizing, 40 scanning, 70 validating, 85 saving, 100 completed.
 */

export type SupabaseClient = any;

/**
 * Update scan_jobs progress/stage and log [SCAN_PROGRESS_WRITE] jobId pct stage count.
 * Callers must enforce: don't decrease progress, check canceled, cap at 95 until final 100.
 * If this never logs, the path never called it. count=0 => jobId mismatch. count=1 but status still queued => read side issue.
 */
export async function updateProgress(
  supabase: SupabaseClient,
  jobId: string,
  pct: number,
  stage: string,
  stageDetail?: string
): Promise<{ count: number; error?: string }> {
  const now = new Date().toISOString();
  const updateData: Record<string, unknown> = {
    progress: pct,
    stage,
    updated_at: now,
    last_heartbeat_at: now,
  };
  if (stageDetail != null) {
    updateData.stage_detail = stageDetail;
  }

  const { data, error } = await supabase
    .from('scan_jobs')
    .update(updateData)
    .eq('id', jobId)
    .select('id');

  const count = data?.length ?? 0;
  console.log('[SCAN_PROGRESS_WRITE]', { jobId, pct, stage, count, error: error?.message });
  return { count, error: error?.message };
}
