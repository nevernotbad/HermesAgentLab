#!/usr/bin/env node
// set-exe-identity.mjs 鈥?stamp the HermesAgentLab icon + version metadata onto the
// built desktop executable using rcedit, completely decoupled from electron-builder's
// signing path.
//
// WHY THIS EXISTS
// ---------------
// apps/desktop/package.json sets build.win.signAndEditExecutable=false. That
// flag is load-bearing: turning electron-builder's own exe-editing ON also
// re-enables its signtool step, which fetches winCodeSign-2.6.0.7z, whose
// macOS symlinks crash 7-Zip on non-admin Windows (no Developer Mode = no
// SeCreateSymbolicLinkPrivilege). That is an unfixable dead end 鈥?we do NOT
// try to extract winCodeSign.
//
// The cost of disabling signAndEditExecutable is that electron-builder also
// skips rcedit, so the unpacked Hermes.exe keeps the stock Electron icon and
// "Electron" taskbar name. This script restores the icon + identity by calling
// rcedit DIRECTLY. rcedit is a pure PE resource editor: no signing, no certs,
// no winCodeSign, no symlinks.
//
// HOW IT RUNS
// -----------
// Primarily as an electron-builder `afterPack` hook (scripts/after-pack.mjs),
// so EVERY packed build 鈥?first install, `hermes desktop`, the installer's
// --update rebuild, or a dev's manual `npm run pack` 鈥?gets a branded exe from
// one place. Previously this stamp lived only in install.ps1, so the update
// path (which rebuilds via `hermes desktop --build-only`, never install.ps1)
// shipped a stock "Electron" exe. Keeping it in afterPack closes that gap.
//
// Also runnable standalone for ad-hoc re-stamping:
//   node scripts/set-exe-identity.mjs <path-to-HermesAgentLab.exe>
//
// Exits 0 on success, non-zero on failure when run as a CLI. As a hook,
// stampExeIdentity() resolves on success and rejects on failure; after-pack
// treats that rejection as fatal so a package with stale Electron identity or
// version metadata cannot be handed to students.

import { resolve, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

import { rcedit } from 'rcedit'

import { isMain } from './utils.mjs'

function exeIdentityOptions(desktopRoot = resolve(import.meta.dirname, '..')) {
  const packageJsonPath = join(desktopRoot, 'package.json')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const version = String(packageJson.version || '').trim()

  if (!/^\d+\.\d+\.\d+(?:[.+-][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid desktop package version in ${packageJsonPath}: ${version || '<empty>'}`)
  }

  return {
    'file-version': version,
    'product-version': version,
    'version-string': {
      ProductName: 'HermesAgentLab',
      FileDescription: 'HermesAgentLab Desktop',
      CompanyName: 'Nous Research',
      LegalCopyright: 'Copyright (c) 2026 Nous Research',
      InternalName: 'HermesAgentLab.exe',
      OriginalFilename: 'HermesAgentLab.exe'
    }
  }
}

// Stamp the Hermes icon + identity onto `exe`. Resolves on success, throws on
// failure. `desktopRoot` defaults to this script's package root so the icon and
// the rcedit dependency resolve regardless of cwd.
async function stampExeIdentity(exe, desktopRoot = resolve(import.meta.dirname, '..')) {
  if (!exe || !existsSync(exe)) {
    throw new Error(`target exe not found: ${exe}`)
  }

  // Icon lives at apps/desktop/assets/icon.ico
  const icon = join(desktopRoot, 'assets', 'icon.ico')
  if (!existsSync(icon)) {
    throw new Error(`icon not found: ${icon}`)
  }

  console.log(`[set-exe-identity] stamping ${exe}`)
  console.log(`[set-exe-identity] icon: ${icon}`)

  await rcedit(exe, { icon, ...exeIdentityOptions(desktopRoot) })

  console.log('[set-exe-identity] done 鈥?HermesAgentLab icon + identity stamped')
}

export { exeIdentityOptions, stampExeIdentity }

// CLI entry point: `node scripts/set-exe-identity.mjs <exe>`.
if (isMain(import.meta.url)) {
  const exe = process.argv[2]
  if (!exe) {
    console.error('[set-exe-identity] usage: set-exe-identity.mjs <path-to-exe>')
    process.exit(2)
  }
  stampExeIdentity(exe).catch(err => {
    console.error(`[set-exe-identity] ${err.message}`)
    process.exit(1)
  })
}

