import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@hsinsekai-nanami/dsh-notifier'

/**
 * client 产物必须是 ModuleLoader.load 包起来的 CJS bundle。
 * 只依赖 web 运行时已有的 react / react/jsx-runtime，其余全部打进 bundle。
 */
const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: ['react', 'react/jsx-runtime', 'react-dom'],
    alwaysBundle: (id: string) => !['react', 'react/jsx-runtime', 'react-dom'].includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [clientBundle] satisfies UserConfig[]
