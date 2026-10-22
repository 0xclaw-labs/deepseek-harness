// @vitest-environment jsdom
//
// Cross-client live cloud desktop (HUI-4001): the renderer-facing bridge offers
// exactly two operations and passes the screen id / URL through unchanged. The
// main process owns credential classification, the delegate request, and the
// gateway-origin restriction; this spec pins the preload half of that split.
import { beforeEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC, type DshDesktopProductApi } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), send: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}))
vi.mock('electron', () => electron)
vi.mock('../src/preload-platform.ts', () => ({ markDocumentPlatform: vi.fn(), syncWindowFullscreen: vi.fn() }))
vi.mock('../src/preload-theme.ts', () => ({ syncNativeTheme: vi.fn() }))
vi.mock('../src/preload-windows.ts', () => ({ syncWindowsAppearance: vi.fn() }))
vi.mock('../src/preload-mandatory-overlay.ts', () => ({ installMandatoryUpdateOverlay: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  vi.stubGlobal('process', { ...process, isMainFrame: true })
  vi.stubGlobal('location', new URL('dsh-app://app/index.html'))
})

const productApi = async (): Promise<DshDesktopProductApi> => {
  await import('../src/preload-app.ts')
  return electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
}

it('routes a screen-id request to the main-process delegate handler', async () => {
  electron.ipcRenderer.invoke.mockResolvedValueOnce({ kind: 'sidebar-guest', url: 'https://agentbuddy.modelxing.com/api/npw/screen/scrn_1/delegate/open?d=t' })
  const api = await productApi()
  const plan = await api.cloudScreen.request('scrn_1')
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.cloudScreenRequest, 'scrn_1')
  expect(plan).toEqual({ kind: 'sidebar-guest', url: 'https://agentbuddy.modelxing.com/api/npw/screen/scrn_1/delegate/open?d=t' })
})

it('routes an explicit system-browser open to the main-process URL check', async () => {
  electron.ipcRenderer.invoke.mockResolvedValueOnce(true)
  const api = await productApi()
  await expect(api.cloudScreen.openExternal('https://agentbuddy.modelxing.com/console.html')).resolves.toBe(true)
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.cloudScreenOpenExternal, 'https://agentbuddy.modelxing.com/console.html')
})

it('does not expose a shell opener, a credential, or a raw fetch to product documents', async () => {
  const api = await productApi()
  expect(api.cloudScreen).not.toHaveProperty('credential')
  expect(api.cloudScreen).not.toHaveProperty('shell')
  expect(api.cloudScreen).not.toHaveProperty('fetch')
  expect(api).not.toHaveProperty('ipcRenderer')
})
