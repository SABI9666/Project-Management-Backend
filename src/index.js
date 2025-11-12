const serverless = require('serverless-http');
const express = require('express');
const cors = require('cors');
const app = express();

// ============================================
// CORS CONFIGURATION - CRITICAL FOR AWS
// ============================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Amz-Date',
        'X-Api-Key',
        'X-Amz-Security-Token',
        'X-Amz-User-Agent',
        'Accept',
        'Cache-Control',
        'X-Requested-With'
    ],
    credentials: false
}));

// Manual CORS headers for extra safety
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token, X-Amz-User-Agent, Accept, Cache-Control, X-Requested-With');
    res.header('Access-Control-Max-Age', '86400'); // 24 hours
    
    // Handle preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
        return res.status(200).json({
            success: true,
            message: 'CORS preflight OK'
        });
    }
    
    next();
});

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.path}`);
    next();
});

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
app.get('/api/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Backend is healthy',
        timestamp: new Date().toISOString(),
        region: process.env.REGION || 'ap-south-1',
        stage: process.env.STAGE || 'production'
    });
});

app.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Backend is healthy'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'EBTracker Backend API',
        version: '1.0.0',
        endpoints: {
            health: '/api/health',
            proposals: '/api/proposals',
            projects: '/api/projects',
            files: '/api/files',
            timesheets: '/api/timesheets',
            users: '/api/users'
        }
    });
});

// ============================================
// IMPORT ROUTES
// ============================================
const proposalsRoutes = require('./routes/proposals');
const projectsRoutes = require('./routes/projects');
const filesRoutes = require('./routes/files');
const timesheetsRoutes = require('./routes/timesheets');
const timeRequestsRoutes = require('./routes/time-requests');
const deliverablesRoutes = require('./routes/deliverables');
const activitiesRoutes = require('./routes/activities');
const notificationsRoutes = require('./routes/notifications');
const paymentsRoutes = require('./routes/payments');
const invoicesRoutes = require('./routes/invoices');
const tasksRoutes = require('./routes/tasks');
const usersRoutes = require('./routes/users');
const submissionsRoutes = require('./routes/submissions');
const analyticsRoutes = require('./routes/analytics');
const dashboardRoutes = require('./routes/dashboard');
const emailRoutes = require('./routes/email');
const variationsRoutes = require('./routes/variations');

// ============================================
// REGISTER ROUTES
// ============================================
app.use('/api/proposals', proposalsRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/timesheets', timesheetsRoutes);
app.use('/api/time-requests', timeRequestsRoutes);
app.use('/api/deliverables', deliverablesRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/submissions', submissionsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/variations', variationsRoutes);

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

// Global error handler
app.use((err, req, res, next) => {
    console.error('❌ Error:', err);
    
    res.status(err.status || 500).json({
        success: false,
        error: err.message || 'Internal server error',
        ...(process.env.STAGE === 'dev' && { stack: err.stack })
    });
});

// ============================================
// EXPORT HANDLER
// ============================================
module.exports.handler = serverless(app, {
    request: (request, event, context) => {
        // Log incoming request
        console.log('📨 Request:', {
            method: event.httpMethod,
            path: event.path,
            headers: event.headers
        });
    },
    response: (response) => {
        // Ensure CORS headers on all responses
        if (!response.headers) {
            response.headers = {};
        }
        
        response.headers['Access-Control-Allow-Origin'] = '*';
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS';
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token';
        
        return response;
    }
});
