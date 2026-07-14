import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeGitHubRepository, rawInstallScriptUrl, validateRemoteInstallScript } from './release-source.mjs'

test('release source normalizes the fork origin and pins raw scripts by full SHA', () => {
  const commit = 'a'.repeat(40)
  assert.equal(
    normalizeGitHubRepository('git@github.com:nevernotbad/HermesAgentLab.git'),
    'nevernotbad/HermesAgentLab'
  )
  assert.equal(
    normalizeGitHubRepository('https://github.com/nevernotbad/HermesAgentLab.git'),
    'nevernotbad/HermesAgentLab'
  )
  assert.equal(
    rawInstallScriptUrl('nevernotbad/HermesAgentLab', commit, 'install.ps1'),
    `https://raw.githubusercontent.com/nevernotbad/HermesAgentLab/${commit}/scripts/install.ps1`
  )
})

test('release source rejects stale remote install scripts', () => {
  assert.throws(
    () => validateRemoteInstallScript('install.ps1', '# old installer', 'nevernotbad/HermesAgentLab'),
    /stale/
  )
  assert.doesNotThrow(() =>
    validateRemoteInstallScript(
      'install.ps1',
      '[string]$RepoSlug = "nevernotbad/HermesAgentLab"\nhttps://github.com/$RepoSlug\nHermesAgentLab.exe',
      'nevernotbad/HermesAgentLab'
    )
  )
})

