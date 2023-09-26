module.exports = {
  apps: [
    {
      name: 'vf-kb-zendesk-import',
      script: 'app.js',
      env_production: {
        PORT: 3002,
        NODE_ENV: 'production',
      },
      watch: false,
    },
  ],
}
