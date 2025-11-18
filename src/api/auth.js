// src/api/auth.js - Authentication API (COMPLETE FINAL VERSION)
const express = require('express');
const { 
    generateToken, 
    createUser: createCognitoUser, 
    authenticateUser,
    getUser,
    validatePassword 
} = require('../utils/cognito');
const { getItem, putItem, queryByIndex, updateItem } = require('../utils/dynamodb');
const { sendNotificationEmail } = require('../utils/email');

const router = express.Router();

// ============================================
// POST /api/auth/register - Register new user
// ============================================
router.post('/register', async (req, res) => {
    console.log('®️ Starting Registration Process...');
    console.log('📦 Request body:', JSON.stringify(req.body, null, 2));
    
    try {
        const { email, password, name, role } = req.body;
        
        // 1. Validation
        if (!email || !password || !name || !role) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                message: 'Email, password, name, and role are required'
            });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid email format'
            });
        }

        // Validate password strength
        if (!validatePassword(password)) {
            return res.status(400).json({
                success: false,
                error: 'Password too weak',
                message: 'Password must be at least 8 characters and include uppercase, lowercase, number, and special character (!@#$%^&*)'
            });
        }

        console.log(`1️⃣ Checking if user exists: ${email}`);
        
        // 2. Check if user already exists in DynamoDB using email-index
        let existingUsers = [];
        try {
            existingUsers = await queryByIndex(
                process.env.USERS_TABLE,
                'email-index',
                {
                    expression: 'email = :email',
                    values: { ':email': email.toLowerCase() }
                }
            );
        } catch (queryError) {
            console.warn('⚠️ Email query failed (index might not exist):', queryError.message);
            // Fallback: scan table to check for email
            const { scanTable } = require('../utils/dynamodb');
            const allUsers = await scanTable(process.env.USERS_TABLE);
            existingUsers = allUsers.filter(u => u.email === email.toLowerCase());
        }
        
        if (existingUsers.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'User already exists',
                message: 'A user with this email already exists'
            });
        }
        
        console.log('2️⃣ Creating user in Cognito...');
        
        // 3. Create user in Cognito
        let cognitoUser;
        try {
            cognitoUser = await createCognitoUser(email, password, name, role);
            console.log('✅ Cognito user created:', cognitoUser);
        } catch (cognitoError) {
            console.error('❌ Cognito Creation Failed:', cognitoError);
            return res.status(400).json({
                success: false,
                error: 'User creation failed',
                message: cognitoError.message
            });
        }
        
        console.log('3️⃣ Saving user to DynamoDB...');

        // 4. Create user in DynamoDB
        // CRITICAL FIX: Use Cognito's actual UUID as primary key
        const timestamp = Date.now();
        const userId = cognitoUser.uid; // Use actual Cognito UUID
        
        console.log(`🔑 Using userId: ${userId}`);
        
        const userData = {
            userId: userId,              // ✅ PRIMARY KEY - Cognito UUID
            uid: userId,                 // Backwards compatibility
            email: email.toLowerCase(),
            name: name,
            role: role,
            status: 'active',
            department: '',
            createdAt: timestamp,
            updatedAt: timestamp,
            activeProjects: 0,
            assignedProjects: 0
        };
        
        console.log('📝 Saving to DynamoDB with data:', JSON.stringify(userData, null, 2));
        
        await putItem(process.env.USERS_TABLE, userData);
        console.log('✅ User saved to DynamoDB');
        
        // 5. Generate JWT token
        const token = generateToken({
            uid: userId,
            userId: userId,
            email: userData.email,
            name: userData.name,
            role: userData.role
        });
        
        console.log('4️⃣ Sending Welcome Email...');

        // 6. Send welcome email (non-blocking)
        try {
            await sendNotificationEmail([email], 'userCreated', {
                name: name,
                email: email,
                role: role,
                password: password
            });
            console.log('✅ Welcome email sent');
        } catch (emailError) {
            console.warn('⚠️ Email failed (SES Sandbox mode):', emailError.message);
            // Don't fail registration if email fails
        }
        
        console.log('✅ Registration Complete');

        return res.status(201).json({
            success: true,
            message: 'User registered successfully',
            data: {
                uid: userData.userId,
                userId: userData.userId,
                email: userData.email,
                name: userData.name,
                role: userData.role,
                status: userData.status
            },
            token: token
        });
    } catch (error) {
        console.error('❌ Registration Error:', error);
        return res.status(500).json({
            success: false,
            error: 'Registration failed',
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// ============================================
// POST /api/auth/login - User login
// ============================================
router.post('/login', async (req, res) => {
    console.log('🔐 Starting Login Process...');
    console.log('📦 Request body:', JSON.stringify({ email: req.body.email, password: '***' }));
    
    try {
        const { email, password } = req.body;
        
        // 1. Validation
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Missing credentials',
                message: 'Email and password are required'
            });
        }
        
        console.log(`1️⃣ Looking up user in DynamoDB: ${email}`);
        
        // 2. Get user from DynamoDB
        let users = [];
        try {
            users = await queryByIndex(
                process.env.USERS_TABLE,
                'email-index',
                {
                    expression: 'email = :email',
                    values: { ':email': email.toLowerCase() }
                }
            );
        } catch (queryError) {
            console.warn('⚠️ Email index query failed, using table scan:', queryError.message);
            // Fallback: scan table
            const { scanTable } = require('../utils/dynamodb');
            const allUsers = await scanTable(process.env.USERS_TABLE);
            users = allUsers.filter(u => u.email === email.toLowerCase());
        }
        
        if (users.length === 0) {
            console.log('❌ User not found in DynamoDB');
            return res.status(401).json({
                success: false,
                error: 'Invalid credentials',
                message: 'Email or password is incorrect'
            });
        }
        
        const user = users[0];
        console.log('✅ User found in DynamoDB:', { 
            userId: user.userId || user.uid, 
            email: user.email, 
            role: user.role 
        });
        
        // 3. Check if user account is active
        if (user.status !== 'active') {
            console.log('❌ User account is not active');
            return res.status(403).json({
                success: false,
                error: 'Account inactive',
                message: 'Your account is not active. Please contact administrator.'
            });
        }
        
        console.log('2️⃣ Authenticating with Cognito...');
        
        // 4. Authenticate with Cognito
        let cognitoAuth;
        try {
            cognitoAuth = await authenticateUser(email, password);
            console.log('✅ Cognito authentication successful');
        } catch (authError) {
            console.error('❌ Cognito authentication failed:', authError.message);
            return res.status(401).json({
                success: false,
                error: 'Invalid credentials',
                message: 'Email or password is incorrect'
            });
        }
        
        console.log('3️⃣ Generating JWT token...');
        
        // 5. Generate JWT token with user data
        const token = generateToken({
            uid: user.userId || user.uid,
            userId: user.userId || user.uid,
            email: user.email,
            name: user.name,
            role: user.role
        });
        
        // 6. Update last login timestamp
        try {
            const primaryKey = user.userId ? { userId: user.userId } : { uid: user.uid };
            await updateItem(
                process.env.USERS_TABLE,
                primaryKey,
                {
                    lastLogin: Date.now(),
                    updatedAt: Date.now()
                }
            );
        } catch (updateError) {
            console.warn('⚠️ Failed to update last login:', updateError.message);
            // Don't fail login if this update fails
        }
        
        console.log('✅ Login successful');
        
        return res.status(200).json({
            success: true,
            message: 'Login successful',
            data: {
                uid: user.userId || user.uid,
                userId: user.userId || user.uid,
                email: user.email,
                name: user.name,
                role: user.role,
                department: user.department || '',
                status: user.status
            },
            token: token,
            cognitoTokens: {
                accessToken: cognitoAuth.accessToken,
                idToken: cognitoAuth.idToken,
                refreshToken: cognitoAuth.refreshToken
            }
        });
    } catch (error) {
        console.error('❌ Login Error:', error);
        return res.status(500).json({
            success: false,
            error: 'Login failed',
            message: 'An error occurred during login. Please try again.',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// ============================================
// GET /api/auth/me - Get current user info
// ============================================
router.get('/me', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized',
                message: 'No authentication token provided'
            });
        }
        
        const token = authHeader.split(' ')[1];
        const { verifyToken } = require('../utils/cognito');
        const decoded = verifyToken(token);
        
        if (!decoded) {
            return res.status(401).json({
                success: false,
                error: 'Invalid token',
                message: 'Authentication token is invalid or expired'
            });
        }
        
        // Try to get user by userId first, then uid
        const userKey = decoded.userId ? { userId: decoded.userId } : { uid: decoded.uid };
        const user = await getItem(process.env.USERS_TABLE, userKey);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found',
                message: 'User account not found'
            });
        }
        
        return res.status(200).json({
            success: true,
            data: {
                uid: user.userId || user.uid,
                userId: user.userId || user.uid,
                email: user.email,
                name: user.name,
                role: user.role,
                department: user.department || '',
                status: user.status,
                activeProjects: user.activeProjects || 0,
                assignedProjects: user.assignedProjects || 0
            }
        });
    } catch (error) {
        console.error('Get user error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to get user info',
            message: error.message
        });
    }
});

// ============================================
// POST /api/auth/logout - User logout
// ============================================
router.post('/logout', async (req, res) => {
    try {
        return res.status(200).json({
            success: true,
            message: 'Logged out successfully'
        });
    } catch (error) {
        console.error('Logout error:', error);
        return res.status(500).json({
            success: false,
            error: 'Logout failed',
            message: error.message
        });
    }
});

// ============================================
// POST /api/auth/change-password - Change password
// ============================================
router.post('/change-password', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
        }
        
        const token = authHeader.split(' ')[1];
        const { verifyToken, changePassword } = require('../utils/cognito');
        const decoded = verifyToken(token);
        
        if (!decoded) {
            return res.status(401).json({
                success: false,
                error: 'Invalid token'
            });
        }
        
        const { newPassword } = req.body;
        
        if (!newPassword) {
            return res.status(400).json({
                success: false,
                error: 'New password is required'
            });
        }
        
        await changePassword(decoded.email, newPassword);
        
        return res.status(200).json({
            success: true,
            message: 'Password changed successfully'
        });
    } catch (error) {
        console.error('Change password error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to change password',
            message: error.message
        });
    }
});

module.exports = router;
