const { join } = require('path');

/**
 * Keep Puppeteer's browser download inside the deployed project.
 * This avoids Render runtime looking in /opt/render/.cache/puppeteer
 * while the build placed Chrome somewhere else.
 *
 * @type {import('puppeteer').Configuration}
 */
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
