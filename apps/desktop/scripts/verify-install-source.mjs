import { execFileSync } from 'node:child_process'
import https from 'node:https'
import path from 'node:path'

import { normalizeGitHubRepository, rawInstallScriptUrl, validateRemoteInstallScript } from './release-source.mjs'

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function downloadTextOnce(url, redirectsLeft = 2) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'HermesAgentLab-release-preflight/1' }, timeout: 60_000 },
      response => {
        if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location && redirectsLeft > 0) {
          response.resume()
          resolve(downloadTextOnce(response.headers.location, redirectsLeft - 1))
          return
        }
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`HTTP ${response.statusCode} from ${url}`))
          return
        }

        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => {
          body += chunk
          if (body.length > 2_000_000) request.destroy(new Error(`response too large from ${url}`))
        })
        response.on('end', () => resolve(body))
        response.on('error', reject)
      }
    )
    request.on('timeout', () => request.destroy(new Error(`timeout fetching ${url}`)))
    request.on('error', reject)
  })
}

async function downloadText(url, attempts = 3) {
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await downloadTextOnce(url)
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        console.warn(`[verify-install-source] retry ${attempt}/${attempts} after ${error.message}`)
      }
    }
  }

  throw lastError
}

async function main() {
  const commit = git(['rev-parse', 'HEAD'])
  const repository =
    normalizeGitHubRepository(process.env.HERMES_BUILD_REPOSITORY) ||
    normalizeGitHubRepository(process.env.GITHUB_REPOSITORY) ||
    normalizeGitHubRepository(git(['remote', 'get-url', 'origin']))

  if (!repository) throw new Error('could not resolve GitHub owner/repo from origin')

  await Promise.all(
    ['install.ps1', 'install.sh'].map(async scriptName => {
      const url = rawInstallScriptUrl(repository, commit, scriptName)
      const source = await downloadText(url)
      validateRemoteInstallScript(scriptName, source, repository)
      console.log(`[verify-install-source] ${scriptName}: ${url} (${source.length} bytes)`)
    })
  )
  console.log(`[verify-install-source] OK: ${repository}@${commit.slice(0, 12)}`)
}

main().catch(error => {
  console.error(`[verify-install-source] ERROR: ${error.message}`)
  console.error('Push the clean release commit to origin before packaging a student installer.')
  process.exit(1)
})

