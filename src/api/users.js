// src/api/users.js - Users API (AWS Version)
const express = require('express');
const { verifyToken, requireRole } = require('../middleware/auth');
const { 
    createUser: createCognitoUser, 
    updateUser: updateCognitoUser,
    setUserStatus,
    listUsersByRole 
} = require('../utils/cognito');
const { 
    getItem, 
    putItem, 
    updateItem, 
    queryByIndex, 
    scanTable 
} = require('../utils/dynamodb');
const { generateId, timestamp } = require('../utils/dynamodb');

const router = express.Router();

// Apply authentication to all routes
router.use(verifyToken);

// ============================================
// GET /api/users - List users
// ============================================
router.get('/', async (req, res) => {
    try {
        const { role, includeInactive, id } = req.query;
        
        // Only COO, Director, and Design Lead can view users
        if (!['coo', 'director', 'design_lead'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'You do not have permission to view users'
            });
        }
        
        // Get single user by ID
        if (id) {
            const user = await getItem(process.env.USERS_TABLE, { uid: id });
            
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
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    status: user.status,
                    department: user.department || '',
                    createdAt: user.createdAt,
                    activeProjects: user.activeProjects || 0,
                    assignedProjects: user.assignedProjects || 0
                }
            });
        }
        
        // List users
        let users = [];
        
        if (role) {
            // Query by role using GSI
            users = await queryByIndex(
                process.env.USERS_TABLE,
                'role-index',
                {
                    expression: '#role = :role',
                    names: { '#role': 'role' },
                    values: { ':role': role }
                }
            );
        } else {
            // Scan all users
            users = await scanTable(process.env.USERS_TABLE);
        }
        
        // Filter out inactive users unless requested
        if (includeInactive !== 'true') {
            users = users.filter(u => u.status === 'active');
        }
        
        // Format response
        const formattedUsers = users.map(user => ({
            uid: user.uid,
            name: user.name,
            email: user.email,
            role: user.role,
            status: user.status || 'active',
            department: user.department || '',
            createdAt: user.createdAt,
            activeProjects: user.activeProjects || 0,
            assignedProjects: user.assignedProjects || 0
        }));
        
        // Sort by name
        formattedUsers.sort((a, b) => a.name.localeCompare(b.name));
        
        return res.status(200).json({
            success: true,
            data: formattedUsers,
            count: formattedUsers.length
        });
    } catch (error) {
        console.error('List users error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to list users',
            message: error.message
        });
    }
});

// ============================================
// POST /api/users - Create user
// ============================================
router.post('/', requireRole(['director']), async (req, res) => {
    try {
        const { email, name, role, department, password } = req.body;
        
        // Validation
        if (!email || !name || !role || !password) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: email, name, role, password'
            });
        }
        
        const validRoles = ['bdm', 'estimator', 'coo', 'director', 'design_lead', 'designer', 'accounts'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid role specified'
            });
        }
        
        // Check if user already exists
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
            department: department || '',
            status: 'active',
            createdAt: timestamp(),
            createdBy: req.user.name,
            createdByUid: req.user.uid,
            updatedAt: timestamp(),
            activeProjects: 0,
            assignedProjects: 0
        };
        
        await putItem(process.env.USERS_TABLE, userData);
        
        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'user_created',
            details: `New ${role} user created: ${name} (${email})`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp()
        });
        
        return res.status(201).json({
            success: true,
            data: userData,
            message: 'User created successfully'
        });
    } catch (error) {
        console.error('Create user error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to create user',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/users/:uid - Update user
// ============================================
router.put('/:uid', requireRole(['director']), async (req, res) => {
    try {
        const { uid } = req.params;
        const { status, role, department } = req.body;
        
        // Get existing user
        const user = await getItem(process.env.USERS_TABLE, { uid });
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
        
        const updates = {
            updatedAt: timestamp(),
            updatedBy: req.user.name,
            updatedByUid: req.user.uid
        };
        
        // Update status
        if (status) {
            if (!['active', 'inactive', 'suspended'].includes(status)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid status'
                });
            }
            updates.status = status;
            
            // Update Cognito user status
            await setUserStatus(uid, status === 'active');
        }
        
        // Update role
        if (role) {
            const validRoles = ['bdm', 'estimator', 'coo', 'director', 'design_lead', 'designer', 'accounts'];
            if (!validRoles.includes(role)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid role'
                });
            }
            updates.role = role;
            
            // Update Cognito custom attribute
            await updateCognitoUser(uid, { 'custom:role': role });
        }
        
        // Update department
        if (department !== undefined) {
            updates.department = department;
        }
        
        // Update in DynamoDB
        await updateItem(process.env.USERS_TABLE, { uid }, updates);
        
        // Log activity
        const updateDetails = [];
        if (status) updateDetails.push(`status: ${status}`);
        if (role) updateDetails.push(`role: ${role}`);
        if (department !== undefined) updateDetails.push(`department: ${department}`);
        
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'user_updated',
            details: `User ${user.name} updated - ${updateDetails.join(', ')}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp()
        });
        
        return res.status(200).json({
            success: true,
            message: 'User updated successfully'
        });
    } catch (error) {
        console.error('Update user error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to update user',
            message: error.message
        });
    }
});

module.exports = router;






















