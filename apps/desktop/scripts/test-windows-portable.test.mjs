import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { assertProbe, portableArtifactName, validatePortableMetadata } from './test-windows-portable.mjs'

test('portable artifact uses the target-specific product name', () => {
  assert.equal(
    portableArtifactName({ version: '1.2.3', build: { portable: { artifactName: 'App-Portable-${version}-${arch}.${ext}' } } }, 'x64'),
    'App-Portable-1.2.3-x64.exe'
  )
})

test('portable launcher metadata follows electron-builder package fields', () => {
  const packageJson = {
    version: '0.1.1',
    productName: 'HermesAgentLab',
    description: 'Native desktop application for Hermes Agent Lab, powered by the Hermes agent runtime.',
    author: 'Nous Research'
  }
  const metadata = {
    ProductName: packageJson.productName,
    FileDescription: packageJson.description,
    CompanyName: packageJson.author,
    InternalName: '',
    OriginalFilename: '',
    FileVersion: packageJson.version,
    ProductVersion: packageJson.version
  }

  assert.doesNotThrow(() => validatePortableMetadata(metadata, packageJson))
  assert.throws(
    () => validatePortableMetadata({ ...metadata, FileDescription: 'HermesAgentLab Desktop' }, packageJson),
    /FileDescription mismatch/
  )
})

test('portable probe requires adjacent desktop and Hermes data paths', () => {
  const launcherDir = 'D:\\Tools\\Ruyi'

  assert.doesNotThrow(() =>
    assertProbe(
      {
        enabled: true,
        executableDir: launcherDir,
        dataDir: path.win32.join(launcherDir, 'data'),
        hermesHome: path.win32.join(launcherDir, 'data', 'hermes'),
        userDataDir: path.win32.join(launcherDir, 'data', 'HermesAgentLab'),
        registerDeepLinkProtocol: false
      },
      launcherDir
    )
  )
})

