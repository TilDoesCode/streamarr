module.exports = function (api) {
  // Native styles inline (Text sets its tone colour itself); NativeWind's per-element JSX wrapper stays web-only.
  const web = api.caller((caller) => caller?.platform === 'web');
  return {
    presets: web
      ? [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel']
      : ['babel-preset-expo'],
  };
};
