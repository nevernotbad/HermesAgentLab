import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { exeIdentityOptions } from './set-exe-identity.mjs'
import { assertSafeInstallTarget, readPeMachine, validateInstalledMetadata } from './test-windows-installer.mjs'

test('Windows executable identity uses the desktop package version', () => {
  const options = exeIdentityOptions()

  assert.equal(options['file-version'], '0.17.0')
  assert.equal(options['product-version'], '0.17.0')
  assert.equal(options['version-string'].ProductName, 'HermesAgentLab')
  assert.equal(options['version-string'].InternalName, 'HermesAgentLab.exe')
})

test('installer smoke target is confined to its dedicated root', () => {
  const root = path.join(os.tmpdir(), 'hermes-installer-smoke-test')
  const safe = path.join(root, 'installer-smoke-1234')

  assert.equal(assertSafeInstallTarget(safe, root), path.resolve(safe))
  assert.throws(() => assertSafeInstallTarget(root, root), /unsafe installer smoke target/)
  assert.throws(() => assertSafeInstallTarget(path.join(root, '..', 'installer-smoke-escape'), root), /outside/)
  assert.throws(() => assertSafeInstallTarget(path.join(root, 'wrong-prefix'), root), /installer-smoke-\*/)
})

test('installed executable metadata enforces product and application versions', () => {
  const metadata = {
    ProductName: 'HermesAgentLab',
    FileDescription: 'HermesAgentLab Desktop',
    CompanyName: 'Nous Research',
    InternalName: 'HermesAgentLab.exe',
    OriginalFilename: 'HermesAgentLab.exe',
    FileVersion: '0.17.0',
    ProductVersion: '0.17.0'
  }

  assert.doesNotThrow(() => validateInstalledMetadata(metadata))
  assert.throws(() => validateInstalledMetadata({ ...metadata, ProductName: 'Electron' }), /ProductName mismatch/)
  assert.throws(() => validateInstalledMetadata({ ...metadata, FileVersion: '40.10.2' }), /must start with 0\.17\.0/)
})

test('PE machine reader verifies the packaged executable architecture field', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-pe-test-'))
  const file = path.join(temp, 'sample.exe')
  const buffer = Buffer.alloc(256)
  buffer.writeUInt16LE(0x5a4d, 0)
  buffer.writeUInt32LE(128, 0x3c)
  buffer.writeUInt32LE(0x00004550, 128)
  buffer.writeUInt16LE(0x8664, 132)
  fs.writeFileSync(file, buffer)

  try {
    assert.equal(readPeMachine(file), 0x8664)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

