// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// content.db를 에셋(require)으로 번들하려면 .db 확장자를 assetExts에 등록해야 한다.
// (설계.md §3.3: Asset.fromModule(require('../assets/db/content.db')) → copyAsync)
config.resolver.assetExts.push('db');

module.exports = config;
