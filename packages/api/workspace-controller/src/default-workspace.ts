/**
 * Fixed first-use Workspace naming, shared by the Host that creates the
 * directory and by browser consumers that label the resulting row. A pure fold
 * with no imports, so client bundles inline it instead of requesting a
 * module-table row this package does not publish.
 * @module @deepseek-ai/dsh-api-workspace-controller/default-workspace
 */

/**
 * Deployment-owned parent directory of the first-use Workspace, used when no
 * complete `defaultWorkspacePath` override is configured. The branded build
 * places it beside the Desktop's own first-use folder instead of reusing the
 * upstream `deepseek-harness` parent, so `dsh web`/`dsh headless` sessions from
 * the bundled CLI never edit the upstream installation's Workspace.
 */
export const DEFAULT_WORKSPACE_PARENT = '随身搭子'

/**
 * Leaf directory name of the first-use Workspace under
 * `<Documents>/<deployment parent>`. Language-neutral, so one installation
 * keeps one on-disk path across language switches. The registry derives the
 * initial title from this same segment, which is the title
 * {@link workspaceDisplayTitle} recognizes as automatic.
 */
export const DEFAULT_WORKSPACE_DIRECTORY = 'default-workspace'

/**
 * The text one Workspace is labeled with. A Workspace still carrying the
 * automatic first-use title reads as the caller's localized default name; every
 * other title reads verbatim in every language. A title the user typed as
 * exactly {@link DEFAULT_WORKSPACE_DIRECTORY} is labeled as the default too;
 * nothing else depends on the distinction.
 * @param title - stored Workspace title.
 * @param localizedDefault - the default Workspace name in the active language.
 * @returns the title to display.
 */
export function workspaceDisplayTitle(title: string, localizedDefault: string): string {
  return title === DEFAULT_WORKSPACE_DIRECTORY ? localizedDefault : title
}
