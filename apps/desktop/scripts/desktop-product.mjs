import path from 'node:path'

function desktopProduct(packageJson) {
  const build = packageJson?.build || {}
  const productName = build.productName || packageJson?.productName
  const executableName = build.executableName || productName
  const artifactName = build.artifactName

  if (!productName || !executableName || !artifactName) {
    throw new Error('desktop package.json must define build.productName, build.executableName, and build.artifactName')
  }

  return { productName, executableName, artifactName }
}

function renderArtifactName(template, { version, os, arch, ext }) {
  return String(template)
    .replaceAll('${version}', version)
    .replaceAll('${os}', os)
    .replaceAll('${arch}', arch)
    .replaceAll('${ext}', ext)
}

function packagedAppLayout({ desktopRoot, packageJson, platform = process.platform, arch = process.arch }) {
  const { productName, executableName } = desktopProduct(packageJson)
  const releaseRoot = path.join(desktopRoot, 'release')
  const normalizedArch = arch === 'arm64' ? 'arm64' : 'x64'

  if (platform === 'darwin') {
    const releaseDir = normalizedArch === 'arm64' ? 'mac-arm64' : 'mac'
    const appPath = path.join(releaseRoot, releaseDir, `${productName}.app`)
    return {
      appPath,
      binary: path.join(appPath, 'Contents', 'MacOS', executableName),
      resourcesPath: path.join(appPath, 'Contents', 'Resources')
    }
  }

  if (platform === 'win32') {
    const releaseDir = normalizedArch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked'
    const appPath = path.join(releaseRoot, releaseDir)
    return {
      appPath,
      binary: path.join(appPath, `${executableName}.exe`),
      resourcesPath: path.join(appPath, 'resources')
    }
  }

  const appPath = path.join(releaseRoot, 'linux-unpacked')
  return {
    appPath,
    binary: path.join(appPath, executableName),
    resourcesPath: path.join(appPath, 'resources')
  }
}

export { desktopProduct, packagedAppLayout, renderArtifactName }

