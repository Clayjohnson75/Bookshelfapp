module.exports = function (api) {
  api.cache(true);
  const plugins = [];

  // Strip console.log/info/debug in production builds (keep warn/error for crash diagnostics).
  if (process.env.NODE_ENV === 'production' || process.env.EAS_ENV === 'production') {
    plugins.push([
      'transform-remove-console',
      { exclude: ['error', 'warn'] },
    ]);
  }

  return {
    presets: ['babel-preset-expo'],
    plugins,
  };
};
