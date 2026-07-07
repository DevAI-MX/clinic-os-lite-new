// ============================================================
// clinicOS — agente Concierge (doctor/equipo). Superficie pública.
// ============================================================

export {
  CONCIERGE_TOOLS,
  CONCIERGE_READ_TOOLS,
  CONCIERGE_WRITE_TOOLS,
  CONCIERGE_WRITE_TOOL_NAMES,
  CONCIERGE_APPT_STATUSES,
  TOOL_STATUS_LABEL,
} from './tools'
export type { ConciergeWriteToolName } from './tools'
export {
  createConciergeExecutor,
  ACTION_EXPIRY_MINUTES,
} from './execute'
export type { ProposedAction, ConciergeExecEvents } from './execute'
export { executeConfirmedAction } from './actions'
export type { ExecuteConfirmedActionArgs } from './actions'
export { buildConciergeSystemPrompt } from './prompt'
