const fs = require('fs');
const envFile = fs.readFileSync('/opt/peak-abu/server/.env', 'utf8');
const env = {};
envFile.split('\n').forEach(line => {
  const [key, ...val] = line.split('=');
  if (key && key.trim() && !key.startsWith('#')) env[key.trim()] = val.join('=').trim();
});

module.exports = {
  apps: [{
    name: 'peak-abu',
    script: 'server/index.js',
    cwd: '/opt/peak-abu',
    env
  }]
};
