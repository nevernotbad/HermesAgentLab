#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { desktopProduct, packagedAppLayout, renderArtifactName } from './desktop-product.mjs'
import { isMain } from './utils.mjs'

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')
const SMOKE_ROOT = path.join(REPO_ROOT, 'tmp', 'desktop-installer-smoke')
const INSTALLER_GUID = '48ae4bdc-0f8d-5252-af1e-bf7c0a8c3649'
const COMPATIBLE_DISPLAY_NAMES = ['HermesAgentLab', 'HermesAgentLab', 'Hermes']

const desktopPackage = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'))
const product = desktopProduct(desktopPackage)

function asArray(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function assertSafeInstallTarget(target, smokeRoot = SMOKE_ROOT) {
  const resolvedRoot = path.resolve(smokeRoot)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`unsafe installer smoke target outside ${resolvedRoot}: ${resolvedTarget}`)
  }
  if (!path.basename(resolvedTarget).startsWith('installer-smoke-')) {
    throw new Error(`installer smoke target must use the installer-smoke-* prefix: ${resolvedTarget}`)
  }
  return resolvedTarget
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()
}

function run(file, args, { timeout = 180_000, env = process.env } = {}) {
  const result = spawnSync(file, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    maxBuffer: 10 * 1024 * 1024,
    timeout,
    windowsHide: true
  })

  if (result.error) {
    throw new Error(`${path.basename(file)} failed to start: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${path.basename(file)} exited ${result.status}${detail ? `:\n${detail}` : ''}`)
  }
  return result
}

function powershellJson(script, env = {}) {
  const result = run(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 30_000, env: { ...process.env, ...env } }
  )
  const output = result.stdout.trim()
  return output ? JSON.parse(output) : null
}

const SYSTEM_STATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$names = [string[]](ConvertFrom-Json -InputObject $env:HERMES_SMOKE_NAMES)
$product = $env:HERMES_SMOKE_PRODUCT
$guid = $env:HERMES_SMOKE_GUID
$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
$registry = @()
foreach ($root in $roots) {
  if (Test-Path -LiteralPath $root) {
    $registry += Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
      $item = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
      if ($null -ne $item -and ($names -contains $item.DisplayName -or $_.PSChildName -match [regex]::Escape($guid))) {
        [pscustomobject]@{
          Key = $_.PSChildName
          Path = $_.PSPath
          DisplayName = $item.DisplayName
          DisplayVersion = $item.DisplayVersion
          UninstallString = $item.UninstallString
          QuietUninstallString = $item.QuietUninstallString
        }
      }
    }
  }
}
$shortcutPaths = @(
  (Join-Path ([Environment]::GetFolderPath('Programs')) ($product + '.lnk')),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) ($product + '.lnk'))
)
$wsh = New-Object -ComObject WScript.Shell
$shortcuts = @($shortcutPaths | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {
  $shortcut = $wsh.CreateShortcut($_)
  [pscustomobject]@{ Path = $_; Target = $shortcut.TargetPath; Arguments = $shortcut.Arguments }
})
$defaultDirs = @()
foreach ($name in $names) {
  $defaultDirs += Join-Path (Join-Path $env:LOCALAPPDATA 'Programs') ([string]$name)
}
$dirs = @($defaultDirs | Where-Object { Test-Path -LiteralPath $_ })
$processNames = @('HermesAgentLab', 'ruyi-agent', 'Hermes')
$processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $processNames -contains $_.ProcessName } | ForEach-Object {
  [pscustomobject]@{ Id = $_.Id; Name = $_.ProcessName; Path = $_.Path }
})
[pscustomobject]@{
  Registry = @($registry)
  Shortcuts = @($shortcuts)
  DefaultDirs = @($dirs)
  Processes = @($processes)
} | ConvertTo-Json -Depth 6 -Compress
`

const PROTOCOL_STATE_SCRIPT = String.raw`
$key = 'HKCU:\Software\Classes\hermes'
if (-not (Test-Path -LiteralPath $key)) {
  [pscustomobject]@{ Exists = $false } | ConvertTo-Json -Compress
  exit 0
}
$item = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
$commandKey = Join-Path $key 'shell\open\command'
$command = if (Test-Path -LiteralPath $commandKey) { (Get-Item -LiteralPath $commandKey).GetValue('') } else { $null }
[pscustomobject]@{
  Exists = $true
  Default = (Get-Item -LiteralPath $key).GetValue('')
  UrlProtocol = $item.'URL Protocol'
  Command = $command
} | ConvertTo-Json -Compress
`

const FILE_METADATA_SCRIPT = String.raw`
$item = Get-Item -LiteralPath $env:HERMES_SMOKE_FILE -ErrorAction Stop
$version = $item.VersionInfo
$signature = Get-AuthenticodeSignature -FilePath $item.FullName
[pscustomobject]@{
  ProductName = $version.ProductName
  FileDescription = $version.FileDescription
  CompanyName = $version.CompanyName
  InternalName = $version.InternalName
  OriginalFilename = $version.OriginalFilename
  FileVersion = $version.FileVersion
  ProductVersion = $version.ProductVersion
  SignatureStatus = [string]$signature.Status
} | ConvertTo-Json -Compress
`

const CLEANUP_REGISTRY_AND_SHORTCUTS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$product = $env:HERMES_SMOKE_PRODUCT
$target = $env:HERMES_SMOKE_TARGET
$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
    $item = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    if ($null -ne $item -and $item.DisplayName -eq $product -and [string]$item.UninstallString -like ('*' + $target + '*')) {
      Remove-Item -LiteralPath $_.PSPath -Recurse -Force
    }
  }
}
@(
  (Join-Path ([Environment]::GetFolderPath('Programs')) ($product + '.lnk')),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) ($product + '.lnk'))
) | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Remove-Item -LiteralPath $_ -Force }
`

function querySystemState() {
  return powershellJson(SYSTEM_STATE_SCRIPT, {
    HERMES_SMOKE_NAMES: JSON.stringify(COMPATIBLE_DISPLAY_NAMES),
    HERMES_SMOKE_PRODUCT: product.productName,
    HERMES_SMOKE_GUID: INSTALLER_GUID
  })
}

function queryProtocolState() {
  return powershellJson(PROTOCOL_STATE_SCRIPT)
}

function fileMetadata(file) {
  return powershellJson(FILE_METADATA_SCRIPT, { HERMES_SMOKE_FILE: file })
}

function validateInstalledMetadata(metadata, packageVersion = desktopPackage.version) {
  const expected = {
    ProductName: product.productName,
    FileDescription: `${product.productName} Desktop`,
    CompanyName: 'Nous Research',
    InternalName: `${product.executableName}.exe`,
    OriginalFilename: `${product.executableName}.exe`
  }

  for (const [key, value] of Object.entries(expected)) {
    if (metadata?.[key] !== value) {
      throw new Error(`installed executable ${key} mismatch: expected ${value}, got ${metadata?.[key] ?? '<empty>'}`)
    }
  }
  for (const key of ['FileVersion', 'ProductVersion']) {
    if (!String(metadata?.[key] || '').startsWith(packageVersion)) {
      throw new Error(
        `installed executable ${key} must start with ${packageVersion}, got ${metadata?.[key] ?? '<empty>'}`
      )
    }
  }
}

function readPeMachine(file) {
  const handle = fs.openSync(file, 'r')
  try {
    const dos = Buffer.alloc(64)
    fs.readSync(handle, dos, 0, dos.length, 0)
    if (dos.readUInt16LE(0) !== 0x5a4d) throw new Error(`not a PE executable: ${file}`)
    const peOffset = dos.readUInt32LE(0x3c)
    const header = Buffer.alloc(6)
    fs.readSync(handle, header, 0, header.length, peOffset)
    if (header.readUInt32LE(0) !== 0x00004550) throw new Error(`invalid PE signature: ${file}`)
    return header.readUInt16LE(4)
  } finally {
    fs.closeSync(handle)
  }
}

function listNativePayloads(root) {
  if (!fs.existsSync(root)) return []
  const found = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) found.push(...listNativePayloads(full))
    else if (entry.isFile() && entry.name.endsWith('.node')) found.push(full)
  }
  return found
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function waitForRemoval(target, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (fs.existsSync(target) && Date.now() < deadline) sleep(200)
  return !fs.existsSync(target)
}

function updaterCache() {
  const root = path.join(process.env.LOCALAPPDATA || '', 'hermes-updater')
  return { root, installer: path.join(root, 'installer.exe') }
}

function removeOwnedUpdaterCache(expectedHash) {
  const cache = updaterCache()
  if (!fs.existsSync(cache.installer)) return
  const actualHash = sha256(cache.installer)
  if (actualHash !== expectedHash) {
    throw new Error(`refusing to remove updater cache with unexpected hash: ${cache.installer}`)
  }
  fs.rmSync(cache.installer)
  if (fs.existsSync(cache.root) && fs.readdirSync(cache.root).length === 0) fs.rmdirSync(cache.root)
}

function ensureEmptyUpdaterCache() {
  const cache = updaterCache()
  if (!cache.root || !path.isAbsolute(cache.root)) throw new Error('LOCALAPPDATA is unavailable')
  if (fs.existsSync(cache.root) && fs.readdirSync(cache.root).length > 0) {
    throw new Error(`refusing host smoke because updater cache is not empty: ${cache.root}`)
  }
}

function emergencyCleanup(target, installerHash) {
  const uninstaller = path.join(target, `Uninstall ${product.productName}.exe`)
  try {
    if (fs.existsSync(uninstaller)) run(uninstaller, ['/currentuser', '/S'], { timeout: 120_000 })
  } catch (error) {
    console.error(`[installer-smoke] emergency uninstaller failed: ${error.message}`)
  }
  waitForRemoval(target, 20_000)
  if (fs.existsSync(target)) {
    assertSafeInstallTarget(target)
    fs.rmSync(target, { recursive: true, force: true })
  }
  try {
    powershellJson(CLEANUP_REGISTRY_AND_SHORTCUTS_SCRIPT, {
      HERMES_SMOKE_PRODUCT: product.productName,
      HERMES_SMOKE_TARGET: target
    })
  } catch (error) {
    console.error(`[installer-smoke] emergency registry cleanup failed: ${error.message}`)
  }
  try {
    removeOwnedUpdaterCache(installerHash)
  } catch (error) {
    console.error(`[installer-smoke] emergency updater-cache cleanup failed: ${error.message}`)
  }
}

function main() {
  if (process.platform !== 'win32') throw new Error('Windows installer smoke test requires Windows')

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const artifact = renderArtifactName(product.artifactName, {
    version: desktopPackage.version,
    os: 'win',
    arch,
    ext: 'exe'
  })
  const installer = path.join(DESKTOP_ROOT, 'release', artifact)
  const unpacked = packagedAppLayout({
    desktopRoot: DESKTOP_ROOT,
    packageJson: desktopPackage,
    platform: 'win32',
    arch: process.arch
  })
  if (!fs.existsSync(installer)) throw new Error(`missing NSIS installer: ${installer}`)
  if (!fs.existsSync(unpacked.binary)) throw new Error(`missing unpacked executable: ${unpacked.binary}`)

  fs.mkdirSync(SMOKE_ROOT, { recursive: true })
  const target = assertSafeInstallTarget(path.join(SMOKE_ROOT, `installer-smoke-${randomUUID().replaceAll('-', '')}`))
  if (fs.existsSync(target)) throw new Error(`installer smoke target already exists: ${target}`)

  const initialState = querySystemState()
  const conflicts = [
    ...asArray(initialState?.Registry),
    ...asArray(initialState?.Shortcuts),
    ...asArray(initialState?.DefaultDirs),
    ...asArray(initialState?.Processes)
  ]
  if (conflicts.length > 0) {
    throw new Error(
      `refusing host smoke because a compatible install, shortcut, directory, or process exists:\n${JSON.stringify(initialState, null, 2)}`
    )
  }
  ensureEmptyUpdaterCache()

  const protocolBefore = queryProtocolState()
  const installerHash = sha256(installer)
  const unpackedHash = sha256(unpacked.binary)
  let installAttempted = false
  let completed = false

  try {
    installAttempted = true
    run(installer, ['/S', '/currentuser', '--no-desktop-shortcut', `/D=${target}`])

    const executable = path.join(target, `${product.executableName}.exe`)
    const appAsar = path.join(target, 'resources', 'app.asar')
    const stampPath = path.join(target, 'resources', 'install-stamp.json')
    const uninstaller = path.join(target, `Uninstall ${product.productName}.exe`)
    for (const required of [executable, appAsar, stampPath, uninstaller]) {
      if (!fs.existsSync(required)) throw new Error(`installed payload is missing: ${required}`)
    }
    if (sha256(executable) !== unpackedHash)
      throw new Error('installed executable differs from the verified unpacked executable')

    const metadata = fileMetadata(executable)
    validateInstalledMetadata(metadata)
    const expectedMachine = process.arch === 'arm64' ? 0xaa64 : 0x8664
    if (readPeMachine(executable) !== expectedMachine) {
      throw new Error(`installed executable has the wrong PE architecture for ${process.arch}`)
    }

    const installerMetadata = fileMetadata(installer)
    const requireSigned = process.env.HERMES_REQUIRE_SIGNED_BUILD === '1'
    for (const [label, value] of [
      ['installer', installerMetadata?.SignatureStatus],
      ['installed executable', metadata?.SignatureStatus]
    ]) {
      if (requireSigned && value !== 'Valid')
        throw new Error(`${label} Authenticode status is ${value}, expected Valid`)
      if (!requireSigned && value !== 'Valid')
        console.warn(`[installer-smoke] warning: ${label} Authenticode status is ${value}`)
    }

    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'))
    if (stamp.repository !== 'nevernotbad/HermesAgentLab')
      throw new Error(`unexpected install-stamp repository: ${stamp.repository}`)
    if (!/^[0-9a-f]{40}$/i.test(String(stamp.commit || '')))
      throw new Error(`invalid install-stamp commit: ${stamp.commit}`)

    const nativePayloads = listNativePayloads(path.join(target, 'resources', 'app.asar.unpacked'))
    if (nativePayloads.length === 0) throw new Error('installed package has no native .node payloads')

    const installedState = querySystemState()
    const registrations = asArray(installedState?.Registry).filter(item => item.DisplayName === product.productName)
    if (registrations.length === 0) throw new Error('NSIS did not create the current-user uninstall registration')
    if (!registrations.some(item => String(item.QuietUninstallString || '').includes(target))) {
      throw new Error('NSIS QuietUninstallString does not point to the isolated smoke target')
    }
    const shortcuts = asArray(installedState?.Shortcuts)
    if (
      shortcuts.length === 0 ||
      shortcuts.some(item => path.resolve(item.Target).toLowerCase() !== path.resolve(executable).toLowerCase())
    ) {
      throw new Error(`installed shortcut does not target ${executable}`)
    }

    const cache = updaterCache()
    if (!fs.existsSync(cache.installer) || sha256(cache.installer) !== installerHash) {
      throw new Error('NSIS updater cache is missing or does not match the tested installer')
    }

    run(uninstaller, ['/currentuser', '/S'], { timeout: 120_000 })
    if (!waitForRemoval(target)) throw new Error(`uninstaller left the install directory behind: ${target}`)
    removeOwnedUpdaterCache(installerHash)

    const finalState = querySystemState()
    const leftovers = [
      ...asArray(finalState?.Registry).filter(item => item.DisplayName === product.productName),
      ...asArray(finalState?.Shortcuts)
    ]
    if (leftovers.length > 0)
      throw new Error(`uninstaller left registry or shortcut state behind:\n${JSON.stringify(finalState, null, 2)}`)
    if (JSON.stringify(queryProtocolState()) !== JSON.stringify(protocolBefore)) {
      throw new Error('installer-only smoke unexpectedly changed the existing hermes:// protocol registration')
    }

    completed = true
    console.log(`[installer-smoke] PASS: installed and uninstalled ${artifact}`)
    console.log(`[installer-smoke] target: ${target}`)
    console.log(
      `[installer-smoke] stamp: ${stamp.repository}@${stamp.commit.slice(0, 12)} dirty=${Boolean(stamp.dirty)}`
    )
    console.log(`[installer-smoke] native payloads: ${nativePayloads.map(file => path.basename(file)).join(', ')}`)
  } finally {
    if (installAttempted && !completed) emergencyCleanup(target, installerHash)
  }
}

export { assertSafeInstallTarget, readPeMachine, validateInstalledMetadata }

if (isMain(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`[installer-smoke] ${error.message}`)
    process.exitCode = 1
  }
}

