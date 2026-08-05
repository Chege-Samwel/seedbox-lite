    'Authorization', 
    'X-Requested-With',
    'Accept',
    'Origin',
    'ngrok-skip-browser-warning'
  ],
  optionsSuccessStatus: 200
}));
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With,Accept,Origin,ngrok-skip-browser-warning');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {