// src/server.js - Express Server for AWS Lambda
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
require('dotenv').config();

// const { verifyToken } = require('./middleware/auth'); // This line was removed in a previous step, keep it removed

const app = express();

// ============================================
// MIDDLEWARE
// ============================================
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());
app.use(morgan('dev'));

// CORS Configuration
app.use(cors({
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        
        const allowedOrigins = [
            'http://localhost:3000',
            'http://localhost:5500',
            'http://127.0.0.1:5500',
            'https://eb-tracker-frontend.vercel.app',
            'https://eb-tracker-frontend-*.vercel.app',
            'http://pmtracker-frontend-2024.s3-website.ap-south-1.amazonaws.com',
            'https://project-management-frontend-seven-ashy.vercel.app',
            'https://project-management-frontend-git-main-sabins-projects-02d8db3a.vercel.app',
            'https.project-management-frontend-byb5vvp8b-sabins-projects-02d8db3a.vercel.app'
        ];
        
        const isAllowed = allowedOrigins.some(allowedOrigin => {
            if (allowedOrigin.includes('*')) {
                const pattern = allowedOrigin.replace('*', '.*');
                return new RegExp(pattern).test(origin);
            }
            return allowedOrigin === origin;
        });
        
        if (isAllowed || (origin && origin.includes('vercel.app'))) {
            callback(null, true);
        } else {
            console.log('⚠️ CORS blocked origin:', origin);
            callback(new Error('This origin is not allowed by CORS')); // Block unauthorized origins
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
        'Content-Type', 
        'Authorization', 
        'X-Requested-With',
        'Accept',
        'Origin',
        'Access-Control-Request-Method',
        'Access-Control-Request-Headers'
    ],
    exposedHeaders: ['Content-Length', 'X-Request-Id'],
    maxAge: 86400
}));

app.options('*', cors());

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
    console.log(`🔥 ${req.method} ${req.path}`);
    if (req.headers.authorization) {
        console.log('🔒 Auth header present');
    }
    next();
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        message: 'EBTracker AWS Backend',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        region: process.env.REGION || 'ap-south-1'
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'EBTracker Backend API - AWS Version',
        version: '2.0.0',
        status: 'running',
        endpoints: [
            'GET  /health - Health check',
            'POST /api/auth/login - User login',
            'POST /api/auth/register - User registration',
            'GET  /api/dashboard - Dashboard data',
            'GET  /api/proposals - List proposals',
            'POST /api/proposals - Create proposal',
            'GET  /api/projects - List projects',
            'POST /api/projects - Create project',
            'GET  /api/users - List users',
            'GET  /api/notifications - Get notifications',
            'GET  /api/activities - Get activities',
            'POST /api/files/upload - Upload file',
            'And more...'
        ]
    });
});

// ============================================
// API ROUTES
// ============================================
console.log('📦 Loading API routes...');

try {
    // Auth routes (no authentication required)
    const authRoutes = require('./api/auth');
    app.use('/api/auth', authRoutes);
    
    // Protected routes (authentication required)
    const dashboardHandler = require('./api/dashboard');
    const proposalsHandler = require('./api/proposals');
    const projectsHandler = require('./api/projects');
    const usersHandler = require('./api/users');
    const notificationsHandler = require('./api/notifications');
    const activitiesHandler = require('./api/activities');
    const paymentsHandler = require('./api/payments');
    const variationsHandler = require('./api/variations');
    const filesHandler = require('./api/files');
    const deliverablesHandler = require('./api/deliverables');
    const timesheetsHandler = require('./api/timesheets');
    const timeRequestsHandler = require('./api/time-requests');
    const emailHandler = require('./api/email');
    
    // Register protected routes
    app.use('/api/dashboard', dashboardHandler);
    app.use('/api/proposals', proposalsHandler);
    app.use('/api/projects', projectsHandler);
    app.use('/api/users', usersHandler);
    app.use('/api/notifications', notificationsHandler);
    app.use('/api/activities', activitiesHandler);
    app.use('/api/payments', paymentsHandler);
    app.use('/api/variations', variationsHandler);
    app.use('/api/files', filesHandler);
    app.use('/api/deliverables', deliverablesHandler);
    app.use('/api/timesheets', timesheetsHandler);
    app.use('/api/time-requests', timeRequestsHandler);
    app.use('/api/email', emailHandler);
    
    console.log('✅ All routes loaded successfully');
} catch (error) {
    console.error('❌ Error loading routes:', error.message);
    console.error('Stack:', error.stack);
}

// ============================================
// ERROR HANDLING
// ============================================
app.use((req, res, next) => {
    console.log(`❌ 404 - Route not found: ${req.method} ${req.path}`);
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        path: req.path,
        method: req.method
    });
});

app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// ============================================
// EXPORT FOR LAMBDA OR LOCAL
// ============================================
module.exports = app;

// For local development
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log('');
        console.log('╔═══════════════════════════════════════╗');
        console.log(`║  ✅ Server running on port ${PORT}      ║`);
        console.log(`║  🌍 Environment: ${(process.env.NODE_ENV || 'development').padEnd(20)}║`);
        console.log('║  🌐 CORS: Enabled for S3 & Vercel      ║');
        console.log('║  ☁️  AWS: DynamoDB + S3 + Cognito      ║');
        console.log('╚═══════════════════════════════════════╝');
        console.log('');
    });
}
