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
  buildPlanBlock,
  ACTION_EXPIRY_MINUTES,
} from './execute'
export type { ProposedAction, ConciergeExecEvents } from './execute'
export {
  executeConfirmedAction,
  confirmProposedAction,
  confirmActionsBatch,
} from './actions'
export type {
  ExecuteConfirmedActionArgs,
  ConfirmActionOutcome,
  ConfirmProposedActionArgs,
  ConfirmActionsBatchArgs,
} from './actions'
export { buildConciergeSystemPrompt } from './prompt'
export { CONCIERGE_SECTIONS, CONCIERGE_SECTION_KEYS } from './blocks'
export type {
  ConciergeBlock,
  AgendaBlock,
  AgendaBlockCita,
  NavigateBlock,
  PlanBlock,
  PlanBlockStep,
  PlanStepStatus,
  ConciergeSectionKey,
} from './blocks'
export {
  parseAttachments,
  buildAttachmentNotes,
  MAX_ATTACHMENTS_PER_TURN,
} from './attachments'
export type { ConciergeAttachment } from './attachments'
export { pickVoiceApiKey, prepareTtsText } from './voice'
