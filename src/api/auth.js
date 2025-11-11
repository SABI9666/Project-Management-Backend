// src/api/auth.js - Authentication API (AWS Version)
const express = require('express');
const bcrypt = require('bcryptjs');
const { generateToken, createUser: createCognitoUser, getUser } = require('../utils/cognito');
const { getItem, putItem, queryByIndex } = require('../utils/dynamodb');
const { sendNotificationEmail } = require('../utils/email');

const router = express.Router();

// ============================================
// POST /api/auth/register - Register new user
// ============================================
router.post('/register', async (req, res) => {
    try {
        const { email, password, name, role } = req.body;
        
        // Validation
        if (!email || !password || !name || !role) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }
        
        // Check if user already exists in DynamoDB
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
        
        // Create user in Cognito
        const cognitoUser = await createCognitoUser(email, password, name, role);
        
        // Create user in DynamoDB
        const userData = {
            uid: cognitoUser.uid,
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
        
        // Generate JWT token
        const token = generateToken(userData);
        
        // Send welcome email
        await sendNotificationEmail([email], 'userCreated', {
            name: name,
            email: email,
            role: role,
            password: password
        });
        
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
        console.error('Registration error:', error);
        return res.status(500).json({
            success: false,
            error: 'Registration failed',
            message: error.message
        });
    }
});

// ============================================
// POST /api/auth/login - User login
// ============================================
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Validation
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
        
        // Check user status
        if (user.status !== 'active') {
            return res.status(403).json({
                success: false,
                error: 'Account is not active'
            });
        }
        
        // Note: For production, implement proper Cognito authentication
        // This is a simplified version - you should use Cognito's InitiateAuth
        
        // Generate JWT token
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
// POST /api/auth/logout - User logout
// ============================================
router.post('/logout', async (req, res) => {
    try {
        // For JWT, logout is handled client-side by removing the token
        return res.status(200).json({
            success: true,
            message: 'Logout successful'
        });
    } catch (error) {
        console.error('Logout error:', error);
        return res.status(500).json({
            success: false,
            error: 'Logout failed'
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






















