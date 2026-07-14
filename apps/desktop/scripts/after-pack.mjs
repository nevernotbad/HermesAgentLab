/**
 * after-pack.mjs 鈥?electron-builder afterPack hook.
 *
 * Stamps the HermesAgentLab icon + identity onto the packed Windows executable via
 * rcedit (delegated to set-exe-identity.mjs). This runs for EVERY packed build
 * 鈥?first install, `hermes desktop`, the installer's --update rebuild, and a
 * dev's manual `npm run pack` 鈥?so the branded exe can never silently revert
 * to the stock "Electron" icon/name (the bug when the stamp lived only in
 * install.ps1, which the update path doesn't use).
 *
 * Windows-only: rcedit edits PE resources, irrelevant on macOS/Linux where the
 * app identity comes from the bundle Info.plist / desktop entry. A stamp
 * failure is fatal: silently shipping the stock Electron identity would make
 * a successful build fail the project's branding contract.
 *
 * electron-builder passes a context with:
 *   - electronPlatformName: 'win32' | 'darwin' | 'linux'
 *   - appOutDir:            the unpacked app directory for this target
 *   - packager.appInfo.productFilename: the exe basename (e.g. 'HermesAgentLab')
 */

import path from 'node:path'

import { stampExeIdentity } from './set-exe-identity.mjs'

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') {
    return
  }

  const productName = context.packager?.appInfo?.productFilename || 'HermesAgentLab'
  const exe = path.join(context.appOutDir, `${productName}.exe`)
  const desktopRoot = path.resolve(import.meta.dirname, '..')

  try {
    await stampExeIdentity(exe, desktopRoot)
  } catch (err) {
    throw new Error(`[after-pack] HermesAgentLab executable identity stamp failed: ${err.message}`)
  }
}

