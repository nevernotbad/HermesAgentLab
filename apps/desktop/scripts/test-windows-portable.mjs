#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { packagedAppLayout, renderArtifactName } from './desktop-product.mjs'
import { readPeMachine, validateInstalledMetadata } from './test-windows-installer.mjs'
import { isMain } from './utils.mjs'

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')
const SMOKE_ROOT = path.join(REPO_ROOT, 'tmp', 'desktop-portable-smoke')
const desktopPackage = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'))

function portableArtifactName(packageJson = desktopPackage, arch = process.arch === 'arm64' ? 'arm64' : 'x64') {
  const template = packageJson?.build?.portable?.artifactName

  if (!template) throw new Error('build.portable.artifactName is not configured')

  return renderArtifactName(template, {
    version: packageJson.version,
    os: 'win',
    arch,
    ext: 'exe'
  })
}

function runPowerShell(script) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true }
  )

  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || `PowerShell exited ${result.status}`)
  return result.stdout.trim()
}

function registrySnapshot() {
  return runPowerShell(String.raw`
$protocolKey = 'HKCU:\Software\Classes\hermes'
$protocolCommandKey = Join-Path $protocolKey 'shell\open\command'
$protocol = if (Test-Path -LiteralPath $protocolKey) {
  $item = Get-ItemProperty -LiteralPath $protocolKey
  [pscustomobject]@{
    Exists = $true
    Default = (Get-Item -LiteralPath $protocolKey).GetValue('')
    UrlProtocol = $item.'URL Protocol'
    Command = if (Test-Path -LiteralPath $protocolCommandKey) { (Get-Item -LiteralPath $protocolCommandKey).GetValue('') } else { $null }
  }
} else { [pscustomobject]@{ Exists = $false } }
$uninstall = @()
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
if (Test-Path -LiteralPath $uninstallRoot) {
  $uninstall = @(Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue | ForEach-Object {
    $item = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    if ($item.DisplayName -in @('HermesAgentLab', 'HermesAgentLab', 'Hermes')) {
      [pscustomobject]@{ Key = $_.PSChildName; DisplayName = $item.DisplayName; UninstallString = $item.UninstallString }
    }
  })
}
$shortcuts = @(
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'HermesAgentLab.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'HermesAgentLab.lnk')
) | Where-Object { Test-Path -LiteralPath $_ }
[pscustomobject]@{ Protocol = $protocol; Uninstall = @($uninstall); Shortcuts = @($shortcuts) } | ConvertTo-Json -Compress -Depth 5
`)
}

function fileMetadata(file) {
  const escaped = file.replaceAll("'", "''")
  const output = runPowerShell(
    `$item = Get-Item -LiteralPath '${escaped}'; $version = $item.VersionInfo; ` +
      `[pscustomobject]@{ProductName=$version.ProductName; FileDescription=$version.FileDescription; ` +
      `CompanyName=$version.CompanyName; InternalName=$version.InternalName; OriginalFilename=$version.OriginalFilename; ` +
      `FileVersion=$version.FileVersion; ProductVersion=$version.ProductVersion; ` +
      `SignatureStatus=(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status.ToString()} | ConvertTo-Json -Compress`
  )
  return JSON.parse(output)
}

function assertProbe(probe, launcherDir) {
  const expectedData = path.join(launcherDir, 'data')

  if (probe.enabled !== true) throw new Error('portable probe did not enable portable mode')
  if (path.resolve(probe.executableDir) !== path.resolve(launcherDir))
    throw new Error(`portable launcher directory mismatch: ${probe.executableDir}`)
  if (path.resolve(probe.dataDir) !== path.resolve(expectedData))
    throw new Error(`portable data directory mismatch: ${probe.dataDir}`)
  if (path.resolve(probe.hermesHome) !== path.resolve(expectedData, 'hermes'))
    throw new Error(`portable HERMES_HOME mismatch: ${probe.hermesHome}`)
  if (path.resolve(probe.userDataDir) !== path.resolve(expectedData, 'HermesAgentLab'))
    throw new Error(`portable userData mismatch: ${probe.userDataDir}`)
  if (probe.registerDeepLinkProtocol !== false) throw new Error('portable build would register hermes://')
}

function validatePortableMetadata(metadata, packageJson = desktopPackage) {
  const companyName =
    typeof packageJson.author === 'string' ? packageJson.author : packageJson.author?.name
  const expected = {
    ProductName: packageJson.productName,
    FileDescription: packageJson.description,
    CompanyName: companyName
  }

  for (const [key, value] of Object.entries(expected)) {
    if (metadata?.[key] !== value) {
      throw new Error(`portable executable ${key} mismatch: expected ${value}, got ${metadata?.[key] ?? '<empty>'}`)
    }
  }
  for (const key of ['FileVersion', 'ProductVersion']) {
    if (!String(metadata?.[key] || '').startsWith(packageJson.version)) {
      throw new Error(
        `portable executable ${key} must start with ${packageJson.version}, got ${metadata?.[key] ?? '<empty>'}`
      )
    }
  }
}

function main() {
  if (process.platform !== 'win32') throw new Error('Windows portable smoke test requires Windows')

  const artifactName = portableArtifactName()
  const artifact = path.join(DESKTOP_ROOT, 'release', artifactName)
  const unpacked = packagedAppLayout({
    desktopRoot: DESKTOP_ROOT,
    packageJson: desktopPackage,
    platform: 'win32',
    arch: process.arch
  })
  if (!fs.existsSync(artifact)) throw new Error(`missing portable artifact: ${artifact}`)
  if (!fs.existsSync(unpacked.binary)) throw new Error(`missing unpacked executable: ${unpacked.binary}`)

  const expectedMachine = process.arch === 'arm64' ? 0xaa64 : 0x8664
  if (readPeMachine(unpacked.binary) !== expectedMachine) {
    throw new Error(`portable application has the wrong PE architecture for ${process.arch}`)
  }

  validateInstalledMetadata(fileMetadata(unpacked.binary))
  const metadata = fileMetadata(artifact)
  validatePortableMetadata(metadata)
  if (metadata.SignatureStatus !== 'Valid') {
    if (process.env.HERMES_REQUIRE_SIGNED_BUILD === '1')
      throw new Error(`portable Authenticode status is ${metadata.SignatureStatus}, expected Valid`)
    console.warn(`[portable-smoke] warning: Authenticode status is ${metadata.SignatureStatus}`)
  }

  fs.mkdirSync(SMOKE_ROOT, { recursive: true })
  const launcherDir = path.join(SMOKE_ROOT, `portable-smoke-${randomUUID().replaceAll('-', '')}`)
  const launcher = path.join(launcherDir, artifactName)
  const probePath = path.join(launcherDir, 'portable-probe.json')
  fs.mkdirSync(launcherDir)
  fs.copyFileSync(artifact, launcher)

  const before = registrySnapshot()

  try {
    const result = spawnSync(launcher, [], {
      cwd: launcherDir,
      env: { ...process.env, HERMES_DESKTOP_PORTABLE_PROBE: probePath },
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true
    })

    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`portable probe exited ${result.status}: ${result.stderr || result.stdout}`)
    if (!fs.existsSync(probePath)) throw new Error('portable probe did not write its result')

    assertProbe(JSON.parse(fs.readFileSync(probePath, 'utf8')), launcherDir)

    const after = registrySnapshot()
    if (after !== before) throw new Error('portable launch changed hermes:// or uninstall registry state')

    console.log(`[portable-smoke] PASS: ${artifactName}`)
    console.log(`[portable-smoke] data root: ${path.join(launcherDir, 'data')}`)
  } finally {
    fs.rmSync(launcherDir, { recursive: true, force: true })
  }
}

export { assertProbe, portableArtifactName, validatePortableMetadata }

if (isMain(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`[portable-smoke] ${error.message}`)
    process.exitCode = 1
  }
}

