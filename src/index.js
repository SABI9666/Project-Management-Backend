// src/index.js
// EB-Tracker Backend - Complete Express App with CORS

const express = require('express');
const serverless = require('serverless-http');
const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();

// ============================================
// CORS MIDDLEWARE - CRITICAL FOR FRONTEND CONNECTION
// ============================================
app.use((req, res, next) => {
  // Set CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token, Accept, Cache-Control, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  res.setHeader('Access-Control-Max-Age', '3600');
  
  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ============================================
// AWS CONFIGURATION
// ============================================
const region = process.env.REGION || 'ap-south-1';
AWS.config.update({ region });

const dynamodb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const cognito = new AWS.CognitoIdentityServiceProvider();
const ses = new AWS.SES();

// Environment variables
const {
  PROPOSALS_TABLE,
  PROJECTS_TABLE,
  FILES_TABLE,
  TIMESHEETS_TABLE,
  TIME_REQUESTS_TABLE,
  DELIVERABLES_TABLE,
  ACTIVITIES_TABLE,
  NOTIFICATIONS_TABLE,
  PAYMENTS_TABLE,
  INVOICES_TABLE,
  TASKS_TABLE,
  USERS_TABLE,
  SUBMISSIONS_TABLE,
  ANALYTICS_TABLE,
  S3_BUCKET,
  COGNITO_USER_POOL_ID,
  COGNITO_CLIENT_ID,
  JWT_SECRET,
  FROM_EMAIL,
  FRONTEND_URL
} = process.env;

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'eb-tracker-backend',
    version: '1.0.0',
    region: region,
    environment: process.env.STAGE || 'production'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'EB-Tracker Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      auth: '/api/auth/*',
      proposals: '/api/proposals',
      projects: '/api/projects',
      files: '/api/files',
      users: '/api/users'
    }
  });
});

// ============================================
// AUTH ROUTES
// ============================================

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    // Authenticate with Cognito
    const authParams = {
      AuthFlow: 'ADMIN_NO_SRP_AUTH',
      UserPoolId: COGNITO_USER_POOL_ID,
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password
      }
    };

    let cognitoUser;
    try {
      const authResult = await cognito.adminInitiateAuth(authParams).promise();
      cognitoUser = authResult.AuthenticationResult;
    } catch (cognitoError) {
      console.error('Cognito authentication error:', cognitoError);
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Get user details from DynamoDB
    const userParams = {
      TableName: USERS_TABLE,
      Key: { email }
    };

    const userResult = await dynamodb.get(userParams).promise();
    
    if (!userResult.Item) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const user = userResult.Item;

    // Generate JWT token
    const token = jwt.sign(
      {
        uid: user.uid,
        email: user.email,
        role: user.role,
        name: user.name
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      data: {
        token,
        user: {
          uid: user.uid,
          email: user.email,
          name: user.name,
          role: user.role,
          department: user.department
        }
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed. Please try again.'
    });
  }
});

// Register (for admin use)
app.post('/api/auth/register', authenticateToken, async (req, res) => {
  try {
    // Only allow admins to register new users
    if (req.user.role !== 'director' && req.user.role !== 'coo') {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized'
      });
    }

    const { email, password, name, role, department } = req.body;

    // Create user in Cognito
    const cognitoParams = {
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: email,
      TemporaryPassword: password,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' }
      ]
    };

    await cognito.adminCreateUser(cognitoParams).promise();

    // Set permanent password
    await cognito.adminSetUserPassword({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: email,
      Password: password,
      Permanent: true
    }).promise();

    // Create user in DynamoDB
    const uid = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const userParams = {
      TableName: USERS_TABLE,
      Item: {
        uid,
        email,
        name,
        role,
        department,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    };

    await dynamodb.put(userParams).promise();

    res.json({
      success: true,
      data: { uid, email, name, role }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Registration failed'
    });
  }
});

// ============================================
// PROPOSALS ROUTES
// ============================================

// Get all proposals (with optional filtering)
app.get('/api/proposals', authenticateToken, async (req, res) => {
  try {
    const params = {
      TableName: PROPOSALS_TABLE
    };

    const result = await dynamodb.scan(params).promise();
    
    // Filter based on user role
    let proposals = result.Items;
    
    if (req.user.role === 'bdm') {
      proposals = proposals.filter(p => p.createdByUid === req.user.uid);
    }

    res.json({
      success: true,
      data: proposals
    });

  } catch (error) {
    console.error('Get proposals error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch proposals'
    });
  }
});

// Get single proposal
app.get('/api/proposals/:id', authenticateToken, async (req, res) => {
  try {
    const params = {
      TableName: PROPOSALS_TABLE,
      Key: { id: req.params.id }
    };

    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      return res.status(404).json({
        success: false,
        error: 'Proposal not found'
      });
    }

    res.json({
      success: true,
      data: result.Item
    });

  } catch (error) {
    console.error('Get proposal error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch proposal'
    });
  }
});

// Create proposal
app.post('/api/proposals', authenticateToken, async (req, res) => {
  try {
    const proposalId = `proposal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const proposal = {
      id: proposalId,
      ...req.body,
      createdByUid: req.user.uid,
      createdByEmail: req.user.email,
      createdByName: req.user.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: req.body.status || 'draft'
    };

    const params = {
      TableName: PROPOSALS_TABLE,
      Item: proposal
    };

    await dynamodb.put(params).promise();

    res.json({
      success: true,
      data: proposal
    });

  } catch (error) {
    console.error('Create proposal error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create proposal'
    });
  }
});

// Update proposal
app.put('/api/proposals/:id', authenticateToken, async (req, res) => {
  try {
    const updates = {
      ...req.body,
      updatedAt: new Date().toISOString()
    };

    // Build update expression
    const updateExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};

    Object.keys(updates).forEach((key, index) => {
      updateExpressions.push(`#attr${index} = :val${index}`);
      expressionAttributeNames[`#attr${index}`] = key;
      expressionAttributeValues[`:val${index}`] = updates[key];
    });

    const params = {
      TableName: PROPOSALS_TABLE,
      Key: { id: req.params.id },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    };

    const result = await dynamodb.update(params).promise();

    res.json({
      success: true,
      data: result.Attributes
    });

  } catch (error) {
    console.error('Update proposal error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update proposal'
    });
  }
});

// Delete proposal
app.delete('/api/proposals/:id', authenticateToken, async (req, res) => {
  try {
    // Only directors and COOs can delete
    if (req.user.role !== 'director' && req.user.role !== 'coo') {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized'
      });
    }

    const params = {
      TableName: PROPOSALS_TABLE,
      Key: { id: req.params.id }
    };

    await dynamodb.delete(params).promise();

    res.json({
      success: true,
      message: 'Proposal deleted successfully'
    });

  } catch (error) {
    console.error('Delete proposal error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete proposal'
    });
  }
});

// ============================================
// PROJECTS ROUTES
// ============================================

// Get all projects
app.get('/api/projects', authenticateToken, async (req, res) => {
  try {
    const params = {
      TableName: PROJECTS_TABLE
    };

    const result = await dynamodb.scan(params).promise();

    res.json({
      success: true,
      data: result.Items
    });

  } catch (error) {
    console.error('Get projects error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch projects'
    });
  }
});

// Get single project
app.get('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const params = {
      TableName: PROJECTS_TABLE,
      Key: { id: req.params.id }
    };

    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    res.json({
      success: true,
      data: result.Item
    });

  } catch (error) {
    console.error('Get project error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch project'
    });
  }
});

// Create project
app.post('/api/projects', authenticateToken, async (req, res) => {
  try {
    const projectId = `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const project = {
      id: projectId,
      ...req.body,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const params = {
      TableName: PROJECTS_TABLE,
      Item: project
    };

    await dynamodb.put(params).promise();

    res.json({
      success: true,
      data: project
    });

  } catch (error) {
    console.error('Create project error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create project'
    });
  }
});

// Update project
app.put('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const updates = {
      ...req.body,
      updatedAt: new Date().toISOString()
    };

    const updateExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};

    Object.keys(updates).forEach((key, index) => {
      updateExpressions.push(`#attr${index} = :val${index}`);
      expressionAttributeNames[`#attr${index}`] = key;
      expressionAttributeValues[`:val${index}`] = updates[key];
    });

    const params = {
      TableName: PROJECTS_TABLE,
      Key: { id: req.params.id },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    };

    const result = await dynamodb.update(params).promise();

    res.json({
      success: true,
      data: result.Attributes
    });

  } catch (error) {
    console.error('Update project error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update project'
    });
  }
});

// ============================================
// FILES/S3 ROUTES
// ============================================

// Generate presigned URL for upload
app.post('/api/files/upload-url', authenticateToken, async (req, res) => {
  try {
    const { fileName, fileType, folder = 'general' } = req.body;
    
    const key = `${folder}/${Date.now()}_${fileName}`;
    
    const params = {
      Bucket: S3_BUCKET,
      Key: key,
      ContentType: fileType,
      Expires: 300 // 5 minutes
    };

    const uploadUrl = s3.getSignedUrl('putObject', params);

    res.json({
      success: true,
      data: {
        uploadUrl,
        key,
        bucket: S3_BUCKET
      }
    });

  } catch (error) {
    console.error('Generate upload URL error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate upload URL'
    });
  }
});

// Get file download URL
app.get('/api/files/download-url/:key', authenticateToken, async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    
    const params = {
      Bucket: S3_BUCKET,
      Key: key,
      Expires: 300 // 5 minutes
    };

    const downloadUrl = s3.getSignedUrl('getObject', params);

    res.json({
      success: true,
      data: { downloadUrl }
    });

  } catch (error) {
    console.error('Generate download URL error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate download URL'
    });
  }
});

// Save file metadata
app.post('/api/files', authenticateToken, async (req, res) => {
  try {
    const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const file = {
      id: fileId,
      ...req.body,
      uploadedBy: req.user.uid,
      uploadedByEmail: req.user.email,
      createdAt: new Date().toISOString()
    };

    const params = {
      TableName: FILES_TABLE,
      Item: file
    };

    await dynamodb.put(params).promise();

    res.json({
      success: true,
      data: file
    });

  } catch (error) {
    console.error('Save file metadata error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save file metadata'
    });
  }
});

// Get files
app.get('/api/files', authenticateToken, async (req, res) => {
  try {
    const params = {
      TableName: FILES_TABLE
    };

    if (req.query.proposalId) {
      params.FilterExpression = 'proposalId = :proposalId';
      params.ExpressionAttributeValues = {
        ':proposalId': req.query.proposalId
      };
    }

    const result = await dynamodb.scan(params).promise();

    res.json({
      success: true,
      data: result.Items
    });

  } catch (error) {
    console.error('Get files error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch files'
    });
  }
});

// ============================================
// USERS ROUTES
// ============================================

// Get all users (admin only)
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'director' && req.user.role !== 'coo') {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized'
      });
    }

    const params = {
      TableName: USERS_TABLE
    };

    const result = await dynamodb.scan(params).promise();

    res.json({
      success: true,
      data: result.Items
    });

  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch users'
    });
  }
});

// Get current user
app.get('/api/users/me', authenticateToken, async (req, res) => {
  try {
    const params = {
      TableName: USERS_TABLE,
      Key: { email: req.user.email }
    };

    const result = await dynamodb.get(params).promise();

    res.json({
      success: true,
      data: result.Item
    });

  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user'
    });
  }
});

// ============================================
// ERROR HANDLING
// ============================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// ============================================
// EXPORT FOR LAMBDA
// ============================================
module.exports.handler = serverless(app);
