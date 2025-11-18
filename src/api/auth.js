// src/api/auth.js - Authentication API (AWS Version)
const express = require('express');
const bcrypt = require('bcryptjs');
// Ensure these utils exist. If 'utils/cognito' is missing, this will fail.
const { generateToken, createUser: createCognitoUser, getUser } = require('../utils/cognito');
const { getItem, putItem, queryByIndex } = require('../utils/dynamodb');
const { sendNotificationEmail } = require('../utils/email');

const router = express.Router();

// ============================================
// POST /api/auth/register - Register new user
// ============================================
router.post('/register', async (req, res) => {
    console.log('®️ Starting Registration Process...');
    try {
        const { email, password, name, role } = req.body;
        
        // 1. Validation
        if (!email || !password || !name || !role) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields (email, password, name, role)'
            });
        }

        console.log(`1️⃣ Checking if user exists: ${email}`);
        
        // 2. Check if user already exists in DynamoDB
        const existingUsers = await queryByIndex(
            process.env.USERS_TABLE,
            'email-index',
            {
                expression: 'email = :email',
                values: { ':email': email }
            }
        );
        
        if (existingUsers.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'User already exists with this email'
            });
        }
        
        console.log('2️⃣ Creating user in Cognito...');
        
        // 3. Create user in Cognito
        // If this fails, it is usually due to Password Policy (requires Upper, Lower, Number, Symbol)
        let cognitoUser;
        try {
            cognitoUser = await createCognitoUser(email, password, name, role);
        } catch (cognitoError) {
            console.error('❌ Cognito Creation Failed:', cognitoError);
            return res.status(400).json({
                success: false,
                error: 'Cognito Creation Failed',
                message: cognitoError.message // Returns specific password policy errors
            });
        }
        
        console.log('3️⃣ Saving user to DynamoDB...');

        // 4. Create user in DynamoDB
        const userData = {
            uid: cognitoUser.uid || cognitoUser.UserSub || 'temp-uid-' + Date.now(), // Fallback if uid missing
            email: email,
            name: name,
            role: role,
            status: 'active',
            department: '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            activeProjects: 0,
            assignedProjects: 0
        };
        
        await putItem(process.env.USERS_TABLE, userData);
        
        // 5. Generate JWT token
        const token = generateToken(userData);
        
        console.log('4️⃣ Sending Welcome Email...');

        // 6. Send welcome email (NON-BLOCKING)
        // We wrap this in try/catch so registration doesn't fail if SES is in Sandbox mode
        try {
            await sendNotificationEmail([email], 'userCreated', {
                name: name,
                email: email,
                role: role,
                password: password
            });
            console.log('✅ Email sent successfully');
        } catch (emailError) {
            console.warn('⚠️ Email failed to send (likely SES Sandbox issue):', emailError.message);
            // Do not return error here, allow registration to complete
        }
        
        console.log('✅ Registration Complete');

        return res.status(201).json({
            success: true,
            message: 'User registered successfully',
            data: {
                uid: userData.uid,
                email: userData.email,
                name: userData.name,
                role: userData.role
            },
            token: token
        });
    } catch (error) {
        console.error('❌ Critical Registration Error:', error);
        return res.status(500).json({
            success: false,
            error: 'Registration failed internal server error',
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// ============================================
// POST /api/auth/login - User login
// ============================================
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Email and password are required'
            });
        }
        
        // Get user from DynamoDB
        const users = await queryByIndex(
            process.env.USERS_TABLE,
            'email-index',
            {
                expression: 'email = :email',
                values: { ':email': email }
            }
        );
        
        if (users.length === 0) {
            return res.status(401).json({
                success: false,
                error: 'Invalid credentials'
            });
        }
        
        const user = users[0];
        
        if (user.status !== 'active') {
            return res.status(403).json({
                success: false,
                error: 'Account is not active'
            });
        }
        
        // Note: Add Cognito Verify Password Logic here if needed
        
        const token = generateToken(user);
        
        return res.status(200).json({
            success: true,
            message: 'Login successful',
            data: {
                uid: user.uid,
                email: user.email,
                name: user.name,
                role: user.role,
                department: user.department
            },
            token: token
        });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({
            success: false,
            error: 'Login failed',
            message: error.message
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
                error: 'Unauthorized'
            });
        }
        
        const token = authHeader.split(' ')[1];
        const { verifyToken } = require('../utils/cognito');
        const decoded = verifyToken(token);
        
        if (!decoded) {
            return res.status(401).json({
                success: false,
                error: 'Invalid token'
            });
        }
        
        const user = await getItem(process.env.USERS_TABLE, { uid: decoded.uid });
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
        
        return res.status(200).json({
            success: true,
            data: {
                uid: user.uid,
                email: user.email,
                name: user.name,
                role: user.role,
                department: user.department,
                status: user.status
            }
        });
    } catch (error) {
        console.error('Get user error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to get user info'
        });
    }
});

module.exports = router;
