// src/index.js
const serverless = require('serverless-http');

// Import the Express app from server.js
// Note: We are now loading 'server.js' instead of having all the code here.
const app = require('./server'); 

// Export the handler for AWS Lambda
module.exports.handler = serverless(app);
