/** Semantic content for the Web-localized optional Desktop status indicator. */
import type { DesktopUpdateFailureKind, DesktopUpdatePresentation, DesktopUpdateState } from './ipc.ts'
import type { DesktopMessages } from './locale.ts'
import type { DesktopUpdateSource } from './update-source.ts'

const NETWORK_FAILURE = /\b(?:ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ETIMEDOUT)\b/u

/**
 * Classify one updater failure for both native and Web-localized summaries.
 * @param state Update failure and its operation.
 * @returns Stable presentation kind without raw diagnostics.
 */
function desktopUpdateFailureKind(state: DesktopUpdateState): DesktopUpdateFailureKind {
  if (state.failedOperation === 'install' && state.preparationFailure !== undefined) return state.preparationFailure
  const operation = state.failedOperation ?? 'install'
  return NETWORK_FAILURE.test(state.message ?? '') ? `${operation}-network` : operation
}

/**
 * Select user-facing error copy independently of raw updater diagnostics.
 * @param state Update failure and its operation.
 * @param messages Selected shell locale.
 * @returns Localized summary suitable for both a dialog and a tooltip.
 */
export function desktopUpdateErrorSummary(state: DesktopUpdateState, messages: DesktopMessages): string {
  const kind = desktopUpdateFailureKind(state)
  const summaries: Readonly<Record<DesktopUpdateFailureKind, string>> = {
    check: messages.updateCheckFailed,
    'check-network': messages.updateCheckNetworkFailed,
    download: messages.updateDownloadFailed,
    'download-network': messages.updateDownloadNetworkFailed,
    install: messages.updateInstallFailed,
    'install-network': messages.updateInstallNetworkFailed,
    'stop-failed': messages.updateStopFailed,
    'tasks-changed': messages.updateTasksChanged,
    'tasks-unavailable': messages.updateTasksUnavailable,
  }
  return summaries[kind]
}

/**
 * @param state - Main-process updater state.
 * @returns Semantic status without localized copy, diagnostics, or installation controls.
 */
export function presentDesktopUpdate(state: DesktopUpdateState): DesktopUpdatePresentation {
  return {
    phase: state.phase,
    ...(state.version === undefined ? {} : { version: state.version }),
    ...(state.percent === undefined ? {} : { percent: Math.floor(state.percent) }),
    ...(state.phase === 'error' ? { failure: desktopUpdateFailureKind(state) } : {}),
  }
}

/** Localized dialog content for a build whose update source is unusable. */
export interface DesktopUpdateUnavailableContent {
  readonly title: string
  readonly message: string
  readonly detail: string
}

/**
 * Describe an unavailable update source in the user's language. A build with no
 * feed and a build whose sealed feed failed validation are different facts, so
 * they never share a message; neither one is reported as a check failure.
 * @param source - Resolved deployment of the packaged feed.
 * @param messages - Selected shell locale.
 * @returns Dialog title, message, and detail for the unavailable source.
 */
export function desktopUpdateUnavailableContent(
  source: DesktopUpdateSource,
  messages: DesktopMessages,
): DesktopUpdateUnavailableContent {
  if (source.kind === 'rejected') {
    return { title: messages.updateUnavailableTitle, message: messages.updateUnavailableRejected,
      detail: messages.updateUnavailableRejectedDetail }
  }
  return { title: messages.updateUnavailableTitle, message: messages.updateUnavailableAbsent,
    detail: messages.updateUnavailableAbsentDetail }
}
