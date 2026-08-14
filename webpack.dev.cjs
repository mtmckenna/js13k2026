const { merge } = require('webpack-merge');
const common = require('./webpack.common.cjs');

module.exports = merge(common, {
    mode: 'development',
    devtool: "inline-source-map",
    devServer: {
        hot: false,
        host: "0.0.0.0",
        // Pinned so the iPad bookmark never breaks; webpack silently picks a
        // different port if this one is taken, which makes the URL a moving target.
        port: 8081,
        allowedHosts: "all",
        headers: {
            'Cache-Control': 'max-age=0',
            'Cache-Control': 'no-store',
        },
    },
});
