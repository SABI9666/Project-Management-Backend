// src/index.js
const serverless = require('serverless-http');

// Import the Express app from server.js
const app = require('./server'); 

// Export the handler for AWS Lambda
module.exports.handler = serverless(app)
