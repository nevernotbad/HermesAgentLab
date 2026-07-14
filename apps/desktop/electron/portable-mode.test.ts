import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  applyPortableEnvironment,
  portableUpdateStatus,
  resolvePortableMode,
  shouldRegisterDeepLinkProtocol
} from './portable-mode'

test('portable mode is enabled only for an absolute Windows launcher directory', () => {
  assert.deepEqual(resolvePortableMode({ env: {}, platform: 'win32', pathModule: path.win32 }), { enabled: false })
  assert.deepEqual(
    resolvePortableMode({ env: { PORTABLE_EXECUTABLE_DIR: 'relative' }, platform: 'win32', pathModule: path.win32 }),
    { enabled: false }
  )
  assert.deepEqual(
    resolvePortableMode({ env: { PORTABLE_EXECUTABLE_DIR: 'D:\\Ruyi' }, platform: 'linux', pathModule: path.win32 }),
    { enabled: false }
  )
})

test('portable mode keeps desktop and Hermes state beside the launcher', () => {
  const mode = resolvePortableMode({
    env: { PORTABLE_EXECUTABLE_DIR: 'D:\\Tools\\HermesAgentLab' },
    platform: 'win32',
    pathModule: path.win32
  })

  assert.deepEqual(mode, {
    enabled: true,
    executableDir: 'D:\\Tools\\HermesAgentLab',
    dataDir: 'D:\\Tools\\HermesAgentLab\\data',
    hermesHome: 'D:\\Tools\\HermesAgentLab\\data\\hermes',
    userDataDir: 'D:\\Tools\\HermesAgentLab\\data\\HermesAgentLab'
  })
  assert.equal(shouldRegisterDeepLinkProtocol(mode), false)
})

test('portable defaults preserve an explicit HERMES_HOME override', () => {
  const mode = resolvePortableMode({
    env: { PORTABLE_EXECUTABLE_DIR: 'D:\\Tools' },
    platform: 'win32',
    pathModule: path.win32
  })
  const defaultEnv: NodeJS.ProcessEnv = {}
  const explicitEnv: NodeJS.ProcessEnv = { HERMES_HOME: 'E:\\HermesData' }

  applyPortableEnvironment(mode, defaultEnv)
  applyPortableEnvironment(mode, explicitEnv)

  assert.equal(defaultEnv.HERMES_DESKTOP_PORTABLE, '1')
  assert.equal(defaultEnv.HERMES_HOME, 'D:\\Tools\\data\\hermes')
  assert.equal(explicitEnv.HERMES_HOME, 'E:\\HermesData')
})

test('portable builds direct updates to executable replacement', () => {
  const mode = resolvePortableMode({
    env: { PORTABLE_EXECUTABLE_DIR: 'D:\\Tools' },
    platform: 'win32',
    pathModule: path.win32
  })

  assert.deepEqual(portableUpdateStatus(mode, 123), {
    supported: false,
    reason: 'portable-build',
    message: 'Replace the portable executable to update. The adjacent data folder is preserved.',
    fetchedAt: 123
  })
  assert.equal(portableUpdateStatus({ enabled: false }), null)
})

