module.exports = {
  apps: [
    {
      name: 'heiken-backend',
      script: 'index.js',
      cwd: './server',
      env: {
        NODE_ENV: 'production',
      },
      env_file: '../.env',
      instances: 1,
      exec_mode: 'cluster',
      watch: false,
      max_memory_restart: '1G',
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
      restart_delay: 1000,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'heiken-frontend',
      script: 'serve',
      args: '-s dist -l 5174 -n',
      cwd: './client',
      instances: 1,
      exec_mode: 'cluster',
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production'
      },
      restart_delay: 1000,
      max_restarts: 10,
      min_uptime: '10s'
    }
  ]
};
