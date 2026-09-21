module.exports = {
  packagerConfig: { asar: true },
  rebuildConfig: {},
  makers: [{ name: '@electron-forge/maker-zip', platforms: ['darwin'] }],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          { entry: 'src/main/main.ts', config: 'vite.main.config.mjs', target: 'main' },
          { entry: 'src/preload/preload.ts', config: 'vite.preload.config.mjs', target: 'preload' },
        ],
        renderer: [{ name: 'main_window', config: 'vite.renderer.config.mjs' }],
      },
    },
  ],
};
