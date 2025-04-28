#!/usr/bin/env node

import path from 'path';
import fs from 'fs-extra';
import { colorconsole, globalConfig, compileOptionsMeta, compileOptionsObject } from '@hap-toolkit/shared-utils';
import { sortFilesBy, lsdirdeep } from './common/utils';
import { DIGEST_ZIP_PATH } from './common/constant';
import {
  createPackagesDefinition,
  allocateResourceToPackages,
  buildProjectAndOutput
} from './process';

const projectPath = process.cwd();

const options = {
  ...compileOptionsObject,
  // 默认排序
  priorities: ['manifest.json', 'app.js'],
  disableSubpackages: false,
  subpackages: null,
  cwd: projectPath,
  pathSrc: path.resolve(projectPath, 'build'),
  pathBuild: path.resolve(projectPath, 'build'),
  output: path.resolve(projectPath, 'dist'),
}

const compiler = {}

/**
 * 递归遍历 base 目录下的所有文件
 * 并按照优先级进行排序
 *
 * @param {String} base - 目标目录
 * @returns {Array<String>|Boolean} - 文件列表
 */
function resolveFiles(base, priorities) {
  let files = lsdirdeep(base)
  if (files.includes(DIGEST_ZIP_PATH)) {
    console.warn(`检测到存在快应用保留文件: ${DIGEST_ZIP_PATH}`)
    return false
  }

  // 按照流式包的策略对文件进行排序
  files = sortFilesBy(files, priorities)
  return files
}

/**
 * 获取签名相关配置
 * @param { Object } options
 */
function getProjectSignConfig(options) {
  // 定位签名路径：默认sign目录
  const projectRoot = options.cwd || globalConfig.projectPath
  const pathSignFolder = options.pathSignFolder || 'sign'

  const privatekey = path.join(projectRoot, pathSignFolder, 'private.pem')
  const certificate = path.join(projectRoot, pathSignFolder, 'certificate.pem')

  return {
    privatekey: fs.readFileSync(privatekey),
    certificate: fs.readFileSync(certificate)
  }
}

/**
 * 获取打包文件名称
 * @param { Object } options
 * @param { String } distExt 文件名后缀
 */
function getDistFilename(options, distExt) {
  if (options.signMode === compileOptionsMeta.signModeEnum.NULL) {
    colorconsole.log(`### App Loader ### 项目构建禁用了签名能力`)
  }

  let flagSign
  switch (options.signMode) {
    case compileOptionsMeta.signModeEnum.NULL:
      flagSign = 'nosign'
      break
    case compileOptionsMeta.signModeEnum.BUILD:
      flagSign = 'debug'
      break
    case compileOptionsMeta.signModeEnum.RELEASE:
      flagSign = 'release'
      break
    default:
      throw new Error(
        `### App Loader ### 编译错误，请联系官方开发人员：signMode出错：${options.signMode}`
      )
  }
  let distName

  let { PACKAGE_NAME, PACKAGE_TYPE, NODE_ENV } =
    globalConfig.launchOptions?.compileOptions?.defineOptions || {}
  // eg.   packageName.release.production.customName.version.rpk
  const distNameOption = [
    PACKAGE_NAME || options.name,
    PACKAGE_TYPE || flagSign,
    NODE_ENV,
    // customName
    undefined,
    options.versionName,
    distExt
  ]
  if (options.buildNameFormat === compileOptionsMeta.buildNameFormat.ORIGINAL) {
    distName = `${options.name}.${flagSign}.${distExt}`
  } else if (options.buildNameFormat && options.buildNameFormat.startsWith('CUSTOM=')) {
    // customName
    distNameOption[3] = options.buildNameFormat.split('=')[1]
  }
  distName = distName || distNameOption.filter(Boolean).join('.')
  return distName
}

/**
 * 把 rpks/rpk 文件写到磁盘
 *
 * @param {Buffer} buffer - rpk（zip）buffer
 * @param {Object} options - 文件参数
 * @param {String} options.name - 包名
 * @param {String} options.output - dist 文件夹路径
 * @param {String} options.signMode 签名模式，值为对应的枚举
 * @param {Boolean} watch - 是否监听
 * @param {('rpks'|'rpk')} distExt - 文件后缀
 */
function generateDistFile(buffer, options, watch, distExt) {
  const distName = getDistFilename(options, distExt)
  const distFile = path.join(options.output, distName)
  fs.writeFileSync(distFile, buffer)
  colorconsole.log(`### App Loader ### 项目构建并生成文件：${distName}`)
}

/**
 * 将 dist 中的文件压缩成 rpk 包，并为其签名
 *
 * @param {Object} options - 插件参数对象
 * @param {String} options.name - 包名
 * @param {String} options.icon - 包的icon
 * @param {String} options.banner 包的banner（可选）
 * @param {String} options.output - dist 文件夹路径
 * @param {String} options.pathSrc - src 路径
 * @param {String} options.pathBuild - rpk 包输出路径
 * @param {String} options.pathSignFolder - 签名文件所在文件夹
 * @param {String} options.versionName - 开发者项目的版本号
 * @param {String} options.versionCode
 * @param {Array<String>} options.priorities - 压缩文件顺序优先级参考数组，将按此数组先后压缩文件
 * @param {Boolean} [options.disableSubpackages=false] - 是否禁用分包
 * @param {Array} [options.subpackages] - 分包列表
 * @param {String} [options.cwd] - 工作目录
 * @param {String} [options.comment] - rpk(zip) 注释
 * @param {Boolean} [options.disableStreamPack] - 关闭流式打包
 * @param {String} options.signMode 签名模式，值为对应的枚举
 * @param {String} options.buildNameFormat 自定义包名，值为对应的枚举
 */
async function run(options) {
  let subpackageOptions = []
  if (!options.disableSubpackages && options.subpackages && options.subpackages.length > 0) {
    subpackageOptions = [...options.subpackages]
  }
  // 更新 options 里的值，防止改变 manifest 文件字段导致的问题
  let manifestPath
  if (fs.pathExistsSync(path.join(options.pathSrc, 'manifest-phone.json'))) {
    // 兼容 device type 逻辑
    manifestPath = path.join(options.pathSrc, 'manifest-phone.json')
  } else {
    manifestPath = path.join(options.pathSrc, 'manifest.json')
  }

  let isPureWidgetProject = true
  if (fs.pathExistsSync(manifestPath)) {
    const manifestContent = fs.readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(manifestContent)
    options.name = manifest.package
    options.versionName = manifest.versionName
    options.versionCode = manifest.versionCode

    if (manifest?.router?.widgets) {
      const widgets = manifest?.router?.widgets || {}
      Object.keys(widgets).forEach((key) => {
        subpackageOptions.push({
          name: key.replaceAll('/', '.'),
          resource: key,
          standalone: true,
          _widget: true
        })
      })
    }
    if (Object.keys(manifest?.router?.pages || {}).length > 0) {
      isPureWidgetProject = false
    }
  }

  let signConfig = null
  try {
    // 增加实例变量
    signConfig = getProjectSignConfig(options)
  } catch (err) {
    console.error(err)
    return
  }

  // 抽取公共JS：app-chunks.json放在app.js之前，page-chunks.json放在app.js之后,便于流式加载
  if (globalConfig.isSmartMode) {
    const appIndex = options.priorities.findIndex((item) => {
      return item === 'app.js'
    })
    options.priorities.splice(appIndex, 0, compileOptionsMeta.splitChunksNameEnum.APP)
    options.priorities.splice(appIndex + 2, 0, compileOptionsMeta.splitChunksNameEnum.PAGE)
  }

  let files = resolveFiles(options.pathBuild, options.priorities)

  // release下 过滤掉rpk内所有.map文件
  if (options.sign === 'release') {
    files = files.filter((file) => !/\.map$/.test(file))
  }

  if (files === false || !files.length) {
    console.error(`### App Loader ### build文件缺失，停止生成应用包，请仔细检查`)
    return
  }

  const { fullPackage, subPackages } = createPackagesDefinition(
    options.name,
    subpackageOptions,
    options.icon,
    options.comment,
    options.banner
  )

  const { _widgetDigestMap } = {}
  if (_widgetDigestMap && Object.keys(_widgetDigestMap)?.length) {
    console.log('fingerprint:', _widgetDigestMap)
  }

  // 遍历文件分配文件资源到每个package里面, 包括digest, file hash
  allocateResourceToPackages(
    files,
    options.pathBuild,
    fullPackage,
    subPackages,
    options.comment,
    _widgetDigestMap
  )

  // 生成最终产出带签名的rpks和rpk文件buffer
  const { rpksBuffer, rpkBuffer } = await buildProjectAndOutput(
    fullPackage,
    subPackages,
    signConfig,
    options.disableStreamPack,
    compiler.watchMode,
    !options.disableSubpackages && !isPureWidgetProject
  )

  fs.ensureDirSync(options.output)

  // 生成rpk/rpks文件
  if (rpkBuffer) {
    generateDistFile(rpkBuffer, options, compiler.watchMode, 'rpk')
  }
  if (rpksBuffer) {
    generateDistFile(rpksBuffer, options, compiler.watchMode, 'rpks')
  }
}

run(options)
