// Synchronous launch timeline callbacks preserve property access and publication order.
export function createLaneTimelineRecorder({ timeline, round, persistTimeline }) {
  return {
    recordLaneStart: ({ phase, model, executor: laneExecutor, startedAt, usageFile, laneId }) => {
      const record = { phase, round: round(phase), ...(laneId ? { lane_id: laneId } : {}), state: 'running', executor: laneExecutor, model, started_at: startedAt, ended_at: null, exit_code: null, usage_file: usageFile }
      timeline.lanes.push(record)
      persistTimeline()
      return record
    },
    recordLaneEnd: (record, endedAt, exitCode) => {
      record.ended_at = endedAt
      record.exit_code = exitCode ?? 'missing'
      record.state = record.exit_code === '0' ? 'completed' : 'failed'
      persistTimeline()
    },
  }
}
